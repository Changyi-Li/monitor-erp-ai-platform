import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { and, desc, eq, like, sql } from 'drizzle-orm';
import {
  type ImportFetchRunResponse,
  type ImportPushRequest,
  type ImportPushResponse,
  type ImportStaged,
  type ImportStagedListResponse,
  type ImportStagedQuery,
} from '@monitor/contracts';
import { can, type FunctionalRole } from '@monitor/shared';
import { STORAGE } from '../adapters/storage/storage.module';
import type { StoragePort } from '../adapters/storage/storage.port';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/current-user.decorator';
import { DRIZZLE, type Database } from '../database/database.module';
import {
  importStagedDocuments,
  kbDocumentVersions,
  kbDocuments,
  type DocumentSyncRow,
  type ImportStagedRow,
  type KbDocumentRow,
  type KbDocumentVersionRow,
} from '../database/schema';
import { RagSyncService } from '../rag/rag-sync.service';
import { fingerprintFile, fingerprintMarkdown } from './fingerprint';
import { IMPORT_SYSTEM_SUB } from './import-auth.guard';
import { IMPORT_SOURCE, type ImportSourcePort } from './import-source.port';
import { decideStage } from './stage-decision';

/** 导入通道前缀（externalKey = `${channel}:${sourceKey}`，键空间隔离） */
export type ImportChannel = 'api' | 'fetch';

/** delete 动作行的指纹哨兵（无内容意义，占位满足 NOT NULL） */
const DELETE_FINGERPRINT = 'delete';

/** 文件类对象存储 key（同 kb.service fileKey 惯例，uuid 天然不重复） */
const fileKey = (documentId: string) => `kb/${documentId}/${crypto.randomUUID()}`;

/** 导入动作审计元信息（withInternalTx 提交后落审计——internal ctx 内写会破坏 uuid 列） */
interface ApplyAudit {
  action: 'import.apply' | 'import.delete';
  metadata: Record<string, unknown>;
  syncId?: string | null;
}

/**
 * Online help 导入编排（issue #25，spec §4.4）：导入 API（外部推送）+ 定时拉取（fetch
 * 清单）双通道 → import_staged_documents 幂等暂存（指纹去重）→ 消费 worker apply
 * 到知识库（先落草稿，人工发布复用 #21 管线进内部 Index）。
 *
 * 关键时序约束（本文件多处注释）：
 * - @Public 路由无请求事务（TenantInterceptor 直接放行）→ 写 staged 必须走
 *   RagSyncService.withInternalTx（RLS fail closed 兜底）；
 * - withInternalTx 的 ALS ctx.userId='system' 是非 uuid 字符串——审计若在事务内
 *   调用会把 'system' 写进 audit_logs.actor_user_id（uuid 列）报错；
 *   全部审计必须在事务提交后（ctx 已清空）记录。
 */
@Injectable()
export class ImportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(STORAGE) private readonly storage: StoragePort,
    private readonly rag: RagSyncService,
    private readonly audit: AuditService,
    @Inject(IMPORT_SOURCE) private readonly source: ImportSourcePort,
  ) {}

  /** 导入维护权限 = kb:edit（仅内部；API-key 哨兵 role='internal' 通过，客户 JWT 403） */
  private assertImportActor(actor: AuthUser): void {
    if (!can(actor.role as FunctionalRole, 'kb:edit')) {
      throw new ForbiddenException('仅内部用户可导入文档');
    }
  }

  /** 是否为 API-key 通道（哨兵 sub；区分审计 actorRole 与 createdById） */
  private isSystemActor(actor: AuthUser): boolean {
    return actor.sub === IMPORT_SYSTEM_SUB;
  }

  /**
   * 导入 API 推送：指纹 → stage 决策（decideStage）→ 幂等暂存 → 提交后审计。
   * upsert：新文档 insert / 变更 reset / 真重复 duplicateCount+1；
   * delete：insert delete 行（同键已存在 → no-op）。
   */
  async push(actor: AuthUser, input: ImportPushRequest): Promise<ImportPushResponse> {
    this.assertImportActor(actor);
    const channel: ImportChannel = 'api';
    const system = this.isSystemActor(actor);

    if (input.action === 'delete') {
      const row = await this.rag.withInternalTx(async (tx) => {
        const [inserted] = await tx
          .insert(importStagedDocuments)
          .values({
            source: channel,
            sourceKey: input.sourceKey,
            action: 'delete',
            fingerprint: DELETE_FINGERPRINT,
            title: input.sourceKey, // 删除行无标题语义；契约 title ≥1 字符，用 sourceKey 占位（调试页显示即删除目标）
            category: 'manual',
            docType: 'markdown',
            status: 'pending',
            createdById: system ? null : actor.sub,
          })
          .onConflictDoNothing({ target: [importStagedDocuments.source, importStagedDocuments.sourceKey, importStagedDocuments.action] })
          .returning();
        // onConflictDoNothing 命中 → 无返回行（apply 幂等去重，不重复入队）
        if (!inserted) {
          const [existing] = await tx
            .select()
            .from(importStagedDocuments)
            .where(
              and(
                eq(importStagedDocuments.source, channel),
                eq(importStagedDocuments.sourceKey, input.sourceKey),
                eq(importStagedDocuments.action, 'delete'),
              ),
            )
            .limit(1);
          if (!existing) {
            // 理论不可达（onConflictDoNothing 命中即有既有行）；防御性兜底
            throw new InternalServerErrorException('删除暂存行不存在');
          }
          return existing;
        }
        return inserted;
      });
      await this.audit.record(AUDIT_ACTIONS.IMPORT_PUSH, {
        actorUserId: system ? undefined : actor.sub,
        actorRole: system ? 'system' : actor.role,
        resourceType: 'import_document',
        resourceId: row.id,
        metadata: { action: 'delete', sourceKey: input.sourceKey, channel },
      });
      return { record: toStagedDto(row), duplicated: false };
    }

    // upsert：指纹 + 决策（查询/写入全在 internal tx 内——@Public 无请求事务，RLS fail closed）
    const fingerprint =
      input.docType === 'markdown'
        ? fingerprintMarkdown(input.body)
        : fingerprintFile(input.base64);
    const externalKey = `${channel}:${input.sourceKey}`;
    const decision = await this.rag.withInternalTx(async (tx) => {
      const [existing] = await tx
        .select()
        .from(importStagedDocuments)
        .where(
          and(
            eq(importStagedDocuments.source, channel),
            eq(importStagedDocuments.sourceKey, input.sourceKey),
            eq(importStagedDocuments.action, 'upsert'),
          ),
        )
        .limit(1);
      const [kbDoc] = await tx
        .select({ id: kbDocuments.id })
        .from(kbDocuments)
        .where(eq(kbDocuments.externalKey, externalKey))
        .limit(1);
      const d = decideStage({ existing, fingerprint, kbDocExists: Boolean(kbDoc) });

      if (d.kind === 'insert') {
        const [row] = await tx
          .insert(importStagedDocuments)
          .values({
            source: channel,
            sourceKey: input.sourceKey,
            action: 'upsert',
            fingerprint,
            title: input.title,
            category: input.category,
            docType: input.docType,
            ...(input.docType === 'markdown'
              ? { body: input.body }
              : { fileName: input.fileName, contentType: input.contentType, base64: input.base64 }),
            metadata: input.metadata,
            status: 'pending',
            createdById: system ? null : actor.sub,
          })
          .returning();
        return { kind: d.kind, row: row! };
      }
      if (d.kind === 'duplicate') {
        // 真重复：不动内容，仅计数（去重日志可见）
        const [row] = await tx
          .update(importStagedDocuments)
          .set({ duplicateCount: existing!.duplicateCount + 1, updatedAt: new Date() })
          .where(eq(importStagedDocuments.id, existing!.id))
          .returning();
        return { kind: d.kind, row: row! };
      }
      // reset：变更更新（新指纹/内容，status→pending 重新消费）或删后回炉（同 fingerprint 也重置）
      const [row] = await tx
        .update(importStagedDocuments)
        .set({
          fingerprint,
          title: input.title,
          category: input.category,
          docType: input.docType,
          ...(input.docType === 'markdown'
            ? { body: input.body }
            : { fileName: input.fileName, contentType: input.contentType, base64: input.base64 }),
          metadata: input.metadata,
          status: 'pending',
          attempt: 0,
          nextRetryAt: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(importStagedDocuments.id, existing!.id))
        .returning();
      return { kind: d.kind, row: row! };
    });

    await this.audit.record(AUDIT_ACTIONS.IMPORT_PUSH, {
      actorUserId: system ? undefined : actor.sub,
      actorRole: system ? 'system' : actor.role,
      resourceType: 'import_document',
      resourceId: decision.row.id,
      metadata: {
        action: 'upsert',
        duplicated: decision.kind === 'duplicate',
        sourceKey: input.sourceKey,
        fingerprint,
        channel,
      },
    });
    return { record: toStagedDto(decision.row), duplicated: decision.kind === 'duplicate' };
  }

  /** 暂存记录列表（调试页；普通 JWT 请求事务 + service 内部断言） */
  async listStaged(
    actor: AuthUser,
    query: ImportStagedQuery,
  ): Promise<ImportStagedListResponse> {
    this.assertImportActor(actor);
    const filters = [];
    if (query.status) {
      filters.push(eq(importStagedDocuments.status, query.status));
    }
    if (query.source) {
      filters.push(eq(importStagedDocuments.source, query.source));
    }
    const rows = await this.db
      .select()
      .from(importStagedDocuments)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(importStagedDocuments.createdAt))
      .limit(200);
    return { records: rows.map(toStagedDto) };
  }

  /**
   * 消费暂存行（worker 调用）：乐观抢单 → apply（upsert 落草稿 / delete 硬删 + RAG
   * delete 入队）→ 状态流转；审计与 notify 在事务提交后（陷阱①）。
   */
  async applyOne(stagedId: string): Promise<void> {
    // 审计与 notify 从事务回调返回值带出（闭包外拿到完整类型；提交后执行——陷阱①）
    const audit = await this.rag.withInternalTx(async (tx): Promise<ApplyAudit | null> => {
      const [claimed] = await tx
        .update(importStagedDocuments)
        .set({ status: 'processing', updatedAt: new Date() })
        .where(
          and(
            eq(importStagedDocuments.id, stagedId),
            sql`${importStagedDocuments.status} in ('pending','failed')`,
          ),
        )
        .returning();
      if (!claimed) {
        return null; // 已被其他消费者处理——幂等防重入
      }
      try {
        const result =
          claimed.action === 'delete'
            ? await this.applyDelete(tx, claimed)
            : await this.applyUpsert(tx, claimed);
        await tx
          .update(importStagedDocuments)
          .set({ status: 'processed', lastError: null, updatedAt: new Date() })
          .where(eq(importStagedDocuments.id, stagedId));
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(message, { cause: err }); // 抛出由 worker 统一退避（保持与 rag worker 同构）
      }
    });
    if (audit) {
      await this.audit.record(audit.action, {
        actorRole: 'system',
        resourceType: 'import_document',
        resourceId: stagedId,
        metadata: audit.metadata,
      });
      if (audit.syncId) {
        await this.rag.notify(audit.syncId); // 事务提交后唤醒 RAG worker
      }
    }
  }

  /** upsert apply：无文档 → 新建草稿；有 → 更新/派生草稿版本（永不自动发布） */
  private async applyUpsert(
    tx: Database,
    claimed: ImportStagedRow,
  ): Promise<ApplyAudit> {
    const externalKey = `${claimed.source}:${claimed.sourceKey}`;
    const [existing] = await tx
      .select()
      .from(kbDocuments)
      .where(eq(kbDocuments.externalKey, externalKey))
      .limit(1);

    // 幂等二次校验：指纹全同 → 已应用（崩溃重放：kb 已写、staged 未标 processed）
    if (existing && existing.fingerprint === claimed.fingerprint) {
      return { action: 'import.apply', metadata: { documentId: existing.id, externalKey, created: false, updated: false } };
    }

    // 文件类每次推送都带新内容 → 新 storage 对象（同 kb.service 覆盖上传先例）；
    // key 提前到联合外，供下方 DB 行先落 + put 两步使用
    const storageKey =
      claimed.docType === 'file' ? fileKey(existing?.id ?? crypto.randomUUID()) : null;
    const versionValues = {
      title: claimed.title,
      category: claimed.category,
      ...(claimed.docType === 'markdown'
        ? { body: claimed.body }
        : {
            fileName: claimed.fileName,
            contentType: claimed.contentType,
            size: claimed.base64 ? Buffer.from(claimed.base64, 'base64').byteLength : 0,
            storageKey,
          }),
    };

    if (existing) {
      if (existing.status === 'draft') {
        // 草稿文档：直接更新文档头 + 草稿版本内容
        await tx
          .update(kbDocuments)
          .set({
            title: claimed.title,
            category: claimed.category,
            fingerprint: claimed.fingerprint,
            updatedAt: new Date(),
          })
          .where(eq(kbDocuments.id, existing.id));
        const draft = await this.draftVersion(tx, existing.id);
        if (draft) {
          await tx
            .update(kbDocumentVersions)
            .set(versionValues)
            .where(eq(kbDocumentVersions.id, draft.id));
        } else {
          await tx.insert(kbDocumentVersions).values({ documentId: existing.id, isPublished: false, ...versionValues });
        }
      } else {
        // 已发布/归档：不碰文档头与线上内容，创建/覆盖草稿版本（外部更新永不自动发布）
        await tx
          .update(kbDocuments)
          .set({ fingerprint: claimed.fingerprint, updatedAt: new Date() })
          .where(eq(kbDocuments.id, existing.id));
        const draft = await this.draftVersion(tx, existing.id);
        if (draft) {
          await tx
            .update(kbDocumentVersions)
            .set(versionValues)
            .where(eq(kbDocumentVersions.id, draft.id));
        } else {
          // 从最新发布版本派生未修改字段（镜像 kb.service 派生草稿逻辑）；versionValues
          // 已含本次完整内容（markdown body / 文件新 key），无需再从线上继承
          await tx.insert(kbDocumentVersions).values({
            documentId: existing.id,
            isPublished: false,
            ...versionValues,
          });
        }
      }
      // 文件类：DB 行先落（storageKey 已定）→ put，失败回滚，key 残留指向空对象
      if (claimed.docType === 'file' && claimed.base64 && storageKey) {
        const buffer = Buffer.from(claimed.base64, 'base64');
        await this.storage.put(storageKey, buffer, {
          contentType: claimed.contentType ?? 'application/octet-stream',
        });
      }
      await tx
        .update(importStagedDocuments)
        .set({ documentId: existing.id })
        .where(eq(importStagedDocuments.id, claimed.id));
      return {
        action: 'import.apply',
        metadata: { documentId: existing.id, externalKey, created: false, updated: true },
      };
    }

    // 新建（先落草稿，人工发布 → #21 管线进内部 Index）
    const [doc] = await tx
      .insert(kbDocuments)
      .values({
        title: claimed.title,
        category: claimed.category,
        docType: claimed.docType,
        status: 'draft',
        source: 'online_help',
        externalKey,
        fingerprint: claimed.fingerprint,
        createdById: null, // 外部导入无平台创建人
      })
      .returning();
    if (!doc) {
      throw new InternalServerErrorException('创建导入文档失败');
    }
    const docKey = fileKey(doc.id);
    const [version] = await tx
      .insert(kbDocumentVersions)
      .values({
        documentId: doc.id,
        isPublished: false,
        title: claimed.title,
        category: claimed.category,
        ...(claimed.docType === 'markdown'
          ? { body: claimed.body }
          : {
              fileName: claimed.fileName,
              contentType: claimed.contentType,
              size: claimed.base64 ? Buffer.from(claimed.base64, 'base64').byteLength : 0,
              storageKey: docKey,
            }),
      })
      .returning();
    if (!version) {
      throw new InternalServerErrorException('创建导入版本失败');
    }
    if (claimed.docType === 'file' && claimed.base64) {
      const buffer = Buffer.from(claimed.base64, 'base64');
      await this.storage.put(docKey, buffer, {
        contentType: claimed.contentType ?? 'application/octet-stream',
      });
    }
    await tx
      .update(importStagedDocuments)
      .set({ documentId: doc.id })
      .where(eq(importStagedDocuments.id, claimed.id));
    return {
      action: 'import.apply',
      metadata: { documentId: doc.id, externalKey, created: true, updated: false },
    };
  }

  /**
   * delete apply = 硬删除（外部源权威「不存在」，弃 archive——墓碑无意义且恢复会复活
   * 无源内容）：draft 直删；published/archived 先入队 RAG delete（已发布进过 Index，
   * 必须移除）再删行 + 删 storage 对象。文档不存在 → no-op（幂等兜底）。
   */
  private async applyDelete(tx: Database, claimed: ImportStagedRow): Promise<ApplyAudit> {
    const externalKey = `${claimed.source}:${claimed.sourceKey}`;
    const [doc] = await tx
      .select()
      .from(kbDocuments)
      .where(eq(kbDocuments.externalKey, externalKey))
      .limit(1);
    if (!doc) {
      return { action: 'import.delete', metadata: { externalKey, removed: false, wasPublished: false } };
    }

    let sync: DocumentSyncRow | null = null;
    if (doc.status === 'published') {
      const published = await this.latestPublishedVersion(tx, doc.id);
      if (published?.versionNumber) {
        sync = await this.rag.enqueueInTx(tx, {
          documentId: doc.id,
          documentType: 'kb_document',
          versionNumber: published.versionNumber,
          action: 'delete',
          scope: 'internal',
          title: doc.title,
        });
      }
    }
    // 收集 storage 对象（版本行可能共享同一线上对象）→ 硬删行（级联删版本）→ 删对象
    const versionKeys = await tx
      .select({ storageKey: kbDocumentVersions.storageKey })
      .from(kbDocumentVersions)
      .where(
        and(eq(kbDocumentVersions.documentId, doc.id), sql`${kbDocumentVersions.storageKey} is not null`),
      );
    await tx.delete(kbDocuments).where(eq(kbDocuments.id, doc.id));
    for (const v of versionKeys) {
      if (v.storageKey) {
        await this.storage.delete(v.storageKey);
      }
    }
    return {
      action: 'import.delete',
      metadata: { documentId: doc.id, externalKey, removed: true, wasPublished: doc.status === 'published' },
      syncId: sync?.id ?? null,
    };
  }

  /**
   * 定时拉取（手动触发/定时器共用）：fetch 清单 → 逐条 stage（source:'fetch'，同 push
   * 决策）→ 删除派生（kb 现有 fetch 文档不在清单 → stageDelete）。计数：
   * fetched = 清单条数；staged = 新入队/重置条数；deleted = 派生删除条数。
   */
  async runFetch(actor: AuthUser | null): Promise<ImportFetchRunResponse> {
    // 手动触发（controller）必须断言；定时器路径传 null 不拦（内部系统动作）
    if (actor) {
      this.assertImportActor(actor);
    }
    const items = await this.source.fetchManifest();
    let staged = 0;
    let deleted = 0;

    await this.rag.withInternalTx(async (tx) => {
      const presentKeys = new Set<string>();
      for (const item of items) {
        presentKeys.add(item.sourceKey);
        const fingerprint =
          item.docType === 'markdown'
            ? fingerprintMarkdown(item.body ?? '')
            : fingerprintFile(item.base64 ?? '');
        const externalKey = `fetch:${item.sourceKey}`;
        const [existing] = await tx
          .select()
          .from(importStagedDocuments)
          .where(
            and(
              eq(importStagedDocuments.source, 'fetch'),
              eq(importStagedDocuments.sourceKey, item.sourceKey),
              eq(importStagedDocuments.action, 'upsert'),
            ),
          )
          .limit(1);
        const [kbDoc] = await tx
          .select({ id: kbDocuments.id })
          .from(kbDocuments)
          .where(eq(kbDocuments.externalKey, externalKey))
          .limit(1);
        const d = decideStage({ existing, fingerprint, kbDocExists: Boolean(kbDoc) });
        if (d.kind === 'duplicate') {
          await tx
            .update(importStagedDocuments)
            .set({ duplicateCount: existing!.duplicateCount + 1, updatedAt: new Date() })
            .where(eq(importStagedDocuments.id, existing!.id));
          continue;
        }
        if (d.kind === 'insert') {
          await tx.insert(importStagedDocuments).values({
            source: 'fetch',
            sourceKey: item.sourceKey,
            action: 'upsert',
            fingerprint,
            title: item.title,
            category: item.category,
            docType: item.docType,
            ...(item.docType === 'markdown'
              ? { body: item.body }
              : { fileName: item.fileName, contentType: item.contentType, base64: item.base64 }),
            metadata: item.updatedAt ? { updatedAt: item.updatedAt } : undefined,
            status: 'pending',
          });
        } else {
          await tx
            .update(importStagedDocuments)
            .set({
              fingerprint,
              title: item.title,
              category: item.category,
              docType: item.docType,
              ...(item.docType === 'markdown'
                ? { body: item.body }
                : { fileName: item.fileName, contentType: item.contentType, base64: item.base64 }),
              metadata: item.updatedAt ? { updatedAt: item.updatedAt } : undefined,
              status: 'pending',
              attempt: 0,
              nextRetryAt: null,
              lastError: null,
              updatedAt: new Date(),
            })
            .where(eq(importStagedDocuments.id, existing!.id));
        }
        staged++;
      }

      // 删除派生：kb 现有 fetch 文档不在本次清单 → stage delete（onConflictDoNothing 幂等）
      const fetchDocs = await tx
        .select({ externalKey: kbDocuments.externalKey })
        .from(kbDocuments)
        .where(like(kbDocuments.externalKey, 'fetch:%'));
      for (const doc of fetchDocs) {
        // LIKE 'fetch:%' 不匹配 NULL，但类型上 externalKey 可空——防御性跳过
        if (!doc.externalKey) {
          continue;
        }
        const sourceKey = doc.externalKey.slice('fetch:'.length);
        if (!presentKeys.has(sourceKey)) {
          await tx
            .insert(importStagedDocuments)
            .values({
              source: 'fetch',
              sourceKey,
              action: 'delete',
              fingerprint: DELETE_FINGERPRINT,
              title: sourceKey, // 删除行标题占位（契约 title ≥1 字符）
              category: 'manual',
              docType: 'markdown',
              status: 'pending',
            })
            .onConflictDoNothing({
              target: [importStagedDocuments.source, importStagedDocuments.sourceKey, importStagedDocuments.action],
            });
          deleted++;
        }
      }
    });

    await this.audit.record(AUDIT_ACTIONS.IMPORT_FETCH, {
      actorUserId: actor ? actor.sub : undefined,
      actorRole: actor ? actor.role : 'system',
      resourceType: 'import_document',
      metadata: { fetched: items.length, staged, deleted },
    });
    return { fetched: items.length, staged, deleted };
  }

  /** 文档的未发布草稿版本（每文档最多一个） */
  private async draftVersion(
    tx: Database,
    documentId: string,
  ): Promise<KbDocumentVersionRow | undefined> {
    const [row] = await tx
      .select()
      .from(kbDocumentVersions)
      .where(
        and(eq(kbDocumentVersions.documentId, documentId), eq(kbDocumentVersions.isPublished, false)),
      )
      .limit(1);
    return row;
  }

  /** 最新发布版本（已发布/归档文档的线上内容） */
  private async latestPublishedVersion(
    tx: Database,
    documentId: string,
  ): Promise<KbDocumentVersionRow | undefined> {
    const [row] = await tx
      .select()
      .from(kbDocumentVersions)
      .where(
        and(eq(kbDocumentVersions.documentId, documentId), eq(kbDocumentVersions.isPublished, true)),
      )
      .orderBy(desc(kbDocumentVersions.versionNumber))
      .limit(1);
    return row;
  }
}

/** 暂存行 → 契约 ImportStaged（Date → ISO；text 枚举列 as 断言，同 issues 先例） */
function toStagedDto(row: ImportStagedRow): ImportStaged {
  return {
    id: row.id,
    source: row.source as 'api' | 'fetch',
    sourceKey: row.sourceKey,
    action: row.action as 'upsert' | 'delete',
    fingerprint: row.fingerprint,
    title: row.title,
    category: row.category as 'manual' | 'faq' | 'best_practice',
    docType: row.docType as 'markdown' | 'file',
    fileName: row.fileName ?? null,
    contentType: row.contentType ?? null,
    documentId: row.documentId ?? null,
    status: row.status as 'pending' | 'processing' | 'processed' | 'failed',
    attempt: row.attempt,
    lastError: row.lastError ?? null,
    duplicateCount: row.duplicateCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
