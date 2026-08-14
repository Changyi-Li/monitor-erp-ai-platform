import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  type RagFailNextResponse,
  type RagIndexResponse,
  type RagSyncsQuery,
  type RagSyncsResponse,
} from '@monitor/contracts';
import { can } from '@monitor/shared';
import { ForbiddenException } from '@nestjs/common';
import { MQ } from '../adapters/mq/mq.module';
import type { MessageQueuePort } from '../adapters/mq/message-queue.port';
import { IDX } from '../adapters/indexing/indexing.module';
import type { DocumentIndexPort, IndexedDocument } from '../adapters/indexing/document-index.port';
import { MemoryDocumentIndexAdapter } from '../adapters/indexing/memory-document-index.adapter';
import type { AuthUser } from '../common/current-user.decorator';
import { DRIZZLE, RAW_DB, type Database } from '../database/database.module';
import {
  blueprints,
  blueprintVersions,
  documentSyncs,
  kbDocumentVersions,
  type DocumentSyncRow,
} from '../database/schema';
import { TenantContextService } from '../database/tenant-context.service';

/** 入队参数（调用方事务内使用；title 快照供调试台显示） */
export interface SyncEnqueueInput {
  documentId: string;
  documentType: 'kb_document' | 'blueprint';
  versionNumber: number;
  action: 'upsert' | 'delete';
  scope: 'internal' | 'customer';
  tenantId?: string | null;
  title: string;
}

/**
 * RAG 同步编排（issue #21，spec §4.3「发布即同步」）。
 * 事务入队：enqueueInTx 在调用方（发布/归档/恢复）事务内 insert 任务行——
 * 「入队失败则发布回滚」；notify 在事务提交后调用（MQ 事件仅唤醒信号，可丢失，
 * worker 定时扫 due 兜底）。真实事务消息由 broker 侧保证（接缝 = MessageQueuePort）。
 */
@Injectable()
export class RagSyncService {
  constructor(
    @Inject(RAW_DB) private readonly base: Database,
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly tenantContext: TenantContextService,
    @Inject(MQ) private readonly mq: MessageQueuePort,
    @Inject(IDX) private readonly idx: DocumentIndexPort,
  ) {}

  /** 内部用户上下文事务（worker 用；复制 tenant.interceptor 模式——SET LOCAL is_internal 旁路 RLS） */
  async withInternalTx<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return this.base.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_internal', 'true', true)`);
      return this.tenantContext.run(
        { tx, tenantId: null, isInternal: true, userId: 'system' },
        () => fn(tx),
      );
    });
  }

  /**
   * 事务内入队（幂等）：同键（documentId, documentType, versionNumber, action）行
   * 已存在（queued/failed 视为已入队）→ 跳过返回 null。
   * **upsert + 已存在 succeeded → 重置为 queued 重新导入**——「归档 → 恢复」场景：
   * delete 已从 Index 移除，需重新上架（同版本无新版本号，不能靠 unique 区分）。
   * 重置行 updated_at 更新 → worker 按「delete 优先、updated_at 升序」处理，保证
   * delete 先于同版本的 upsert（Index 先下架再重建，最终状态正确）。
   */
  async enqueueInTx(
    tx: Database,
    input: SyncEnqueueInput,
  ): Promise<DocumentSyncRow | null> {
    const [existing] = await tx
      .select()
      .from(documentSyncs)
      .where(
        and(
          eq(documentSyncs.documentId, input.documentId),
          eq(documentSyncs.documentType, input.documentType),
          eq(documentSyncs.versionNumber, input.versionNumber),
          eq(documentSyncs.action, input.action),
        ),
      )
      .limit(1);
    if (existing) {
      if (input.action === 'upsert' && existing.status === 'succeeded') {
        const [row] = await tx
          .update(documentSyncs)
          .set({
            status: 'queued',
            attempt: 0,
            nextRetryAt: null,
            lastError: null,
            title: input.title,
            updatedAt: new Date(),
          })
          .where(eq(documentSyncs.id, existing.id))
          .returning();
        return row ?? null;
      }
      return null; // 幂等：重复事件不重复导入
    }
    const [row] = await tx
      .insert(documentSyncs)
      .values({
        documentId: input.documentId,
        documentType: input.documentType,
        versionNumber: input.versionNumber,
        action: input.action,
        scope: input.scope,
        tenantId: input.tenantId ?? null,
        title: input.title,
      })
      .returning();
    return row ?? null;
  }

  /** 事务提交后唤醒 worker（MQ 事件；丢失由 worker 定时扫 due 兜底） */
  async notify(syncId: string): Promise<void> {
    await this.mq.publish('document.sync', { syncId });
  }

  /** 同步任务列表（调试台面板；controller 已做 rag:view 校验——内部用户请求事务 RLS 旁路全见） */
  async listSyncs(query: RagSyncsQuery): Promise<RagSyncsResponse> {
    const filters = [];
    if (query.status) {
      filters.push(eq(documentSyncs.status, query.status));
    }
    if (query.scope) {
      filters.push(eq(documentSyncs.scope, query.scope));
    }
    const rows = await this.db
      .select()
      .from(documentSyncs)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(documentSyncs.createdAt))
      .limit(200);
    return { syncs: rows.map(toSyncDto) };
  }

  /** fake Index 可见文档（调试台；scope 路由验证——internal/customer 各归其位） */
  async listIndex(scope: 'internal' | 'customer'): Promise<RagIndexResponse> {
    const docs = await this.idx.list(scope);
    return {
      scope,
      documents: docs.map((d) => ({
        documentId: d.documentId,
        versionNumber: d.versionNumber,
        title: d.title,
        contentType: d.contentType ?? null,
        updatedAt: d.updatedAt.toISOString(),
      })),
    };
  }

  /** 调试注入：「下一次 upsert 抛错」演示失败重试；仅 memory 驱动有效 */
  async failNext(): Promise<RagFailNextResponse> {
    if (this.idx instanceof MemoryDocumentIndexAdapter) {
      this.idx.failNextUpsertOnce();
      return { armed: true };
    }
    return { armed: false };
  }

  /** rag:view = 仅内部（spec 用户故事 50；无项目上下文，直接按 JWT 角色） */
  assertRagView(actor: AuthUser): void {
    if (!can(actor.role, 'rag:view')) {
      throw new ForbiddenException('仅内部用户可访问 RAG 调试台');
    }
  }

  /** worker 内容提取：按任务行组装 IndexedDocument（幂等键 = documentId + versionNumber） */
  async buildEntry(tx: Database, row: DocumentSyncRow): Promise<IndexedDocument> {
    if (row.documentType === 'kb_document') {
      const [v] = await tx
        .select({
          body: kbDocumentVersions.body,
          fileName: kbDocumentVersions.fileName,
          contentType: kbDocumentVersions.contentType,
        })
        .from(kbDocumentVersions)
        .where(
          and(
            eq(kbDocumentVersions.documentId, row.documentId),
            eq(kbDocumentVersions.versionNumber, row.versionNumber),
            eq(kbDocumentVersions.isPublished, true),
          ),
        )
        .limit(1);
      if (!v) {
        throw new Error(`kb 版本 ${row.versionNumber} 不存在或未发布`);
      }
      const content = v.body ?? (v.fileName ? `${v.fileName}（${v.contentType ?? ''}）` : '');
      return {
        documentId: row.documentId,
        versionNumber: row.versionNumber,
        scope: row.scope,
        title: row.title,
        content,
        contentType: v.body != null ? 'text/markdown' : (v.contentType ?? undefined),
        documentType: 'kb_document', // issue #22：引用跳转路由依据
        updatedAt: new Date(),
      };
    }
    // blueprint：4 结构化字段 + 流程图文件名拼接文本（drawio 本体解析为真实平台增强）
    const [v] = await tx
      .select({
        businessRequirements: blueprintVersions.businessRequirements,
        moduleScope: blueprintVersions.moduleScope,
        configNotes: blueprintVersions.configNotes,
        processDescription: blueprintVersions.processDescription,
        drawioName: blueprintVersions.drawioName,
        // issue #22：引用跳转 /projects/{projectId}/blueprints 需要项目 id
        projectId: blueprints.projectId,
      })
      .from(blueprintVersions)
      .innerJoin(blueprints, eq(blueprints.id, blueprintVersions.blueprintId))
      .where(
        and(
          eq(blueprintVersions.blueprintId, row.documentId),
          eq(blueprintVersions.version, row.versionNumber),
        ),
      )
      .limit(1);
    if (!v) {
      throw new Error(`蓝图版本 ${row.versionNumber} 不存在`);
    }
    const content = [
      `蓝图：${row.title}`,
      `业务需求：${v.businessRequirements ?? ''}`,
      `模块功能范围：${v.moduleScope ?? ''}`,
      `配置说明：${v.configNotes ?? ''}`,
      `流程描述：${v.processDescription ?? ''}`,
      `流程图文件：${v.drawioName ?? ''}`,
    ]
      .filter((s) => s && !s.endsWith('：'))
      .join('\n\n');
    return {
      documentId: row.documentId,
      versionNumber: row.versionNumber,
      scope: row.scope,
      title: row.title,
      content,
      contentType: 'text/plain',
      documentType: 'blueprint',
      projectId: v.projectId,
      updatedAt: new Date(),
    };
  }
}

/** 任务行 → 契约 RagSync（Date → ISO；text 枚举列 as 断言，同 issues 先例） */
function toSyncDto(row: DocumentSyncRow): RagSyncsResponse['syncs'][number] {
  return {
    id: row.id,
    documentId: row.documentId,
    documentType: row.documentType as 'kb_document' | 'blueprint',
    versionNumber: row.versionNumber,
    action: row.action as 'upsert' | 'delete',
    scope: row.scope as 'internal' | 'customer',
    tenantId: row.tenantId ?? null,
    title: row.title,
    status: row.status as 'queued' | 'processing' | 'succeeded' | 'failed',
    attempt: row.attempt,
    lastError: row.lastError ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
