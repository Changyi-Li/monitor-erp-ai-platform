import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, max, ne, type SQL } from 'drizzle-orm';
import {
  type KbCreateRequest,
  type KbDocumentDetail,
  type KbDocumentResponse,
  type KbListResponse,
  type KbUpdateRequest,
  type KbVersion,
  type KbVersionsResponse,
  type KbViewerRole,
} from '@monitor/contracts';
import { can, type FunctionalRole } from '@monitor/shared';
import { STORAGE } from '../adapters/storage/storage.module';
import type { StoragePort } from '../adapters/storage/storage.port';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/current-user.decorator';
import { DRIZZLE, type Database } from '../database/database.module';
import {
  kbDocumentVersions,
  kbDocuments,
  users,
  type KbDocumentRow,
  type KbDocumentVersionRow,
} from '../database/schema';
import { TenantContextService } from '../database/tenant-context.service';
import { RagSyncService } from '../rag/rag-sync.service';

/** base64 解码上限：KbCreateRequestSchema.base64 ≤ 8_000_000 字符 ≈ 6MB 二进制（同 drawio/minutes） */
const MAX_FILE_BYTES = 6_000_000;

/** 详情契约除 viewerRole 外的公共部分（组装过程形状；viewerRole 由端点补齐） */
type KbDocumentDetailWithoutRole = Omit<KbDocumentDetail, 'viewerRole'>;

/** 文件类文档对象存储 key（uuid 天然不重复） */
const fileKey = (documentId: string) => `kb/${documentId}/${crypto.randomUUID()}`;

/**
 * 内部知识库（issue #19，spec §4.1/§4.3）：**全局文档域**（区别于项目级域——不挂客户/项目，
 * 客户知识库 = 内部 KB + 本项目文档是逻辑视图，spec §4.2）。RLS 双策略无租户维度：
 * 内部全权（kb_documents_internal_manage）+ 已发布全员可读（read_published，含客户）。
 *
 * 权限（零新增：kb:edit 已在矩阵，spec §2.4「知识库文档编辑 ✅ 仅内部」）：维护 = 内部；
 * 查看默认开放（无 kb:view）——客户用户只读已发布（草稿/归档 RLS 挡 → 404）。
 *
 * 版本化：版本 = 全字段快照（title/category/body 或文件三件套）；每文档最多一个未发布
 * 草稿版本（isPublished=false, versionNumber=null），草稿保存 = 原地更新该行；发布 = 该行
 * 转正（versionNumber = max+1）并把快照写回文档头——「重新发布才生效」对标题/分类同样成立。
 * 发布动作是 RAG 同步触发点（切片 11/#21），本期只做状态机 + 审计。
 */
@Injectable()
export class KbService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(STORAGE) private readonly storage: StoragePort,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly rag: RagSyncService,
  ) {}

  /** 全局域 viewerRole：内部 → 'internal'；客户用户（须 isActive，查 users 表）→ 'customer' */
  private async resolveViewerRole(actor: AuthUser, ctx: { isInternal: boolean }): Promise<KbViewerRole> {
    if (ctx.isInternal) {
      return 'internal';
    }
    const [user] = await this.db
      .select({ isActive: users.isActive })
      .from(users)
      .where(eq(users.id, actor.sub))
      .limit(1);
    if (!user || !user.isActive) {
      throw new ForbiddenException('账号已停用');
    }
    return 'customer';
  }

  /** 维护权限（仅内部：kb:edit，spec §2.4） */
  private assertCanManage(viewerRole: KbViewerRole, message: string): void {
    if (!can(viewerRole as FunctionalRole, 'kb:edit')) {
      throw new ForbiddenException(message);
    }
  }

  /** 文档行（RLS 过滤：内部全看；客户仅已发布——草稿/归档 → 404 防探测） */
  private async requireDocument(documentId: string): Promise<KbDocumentRow> {
    const [row] = await this.db
      .select()
      .from(kbDocuments)
      .where(eq(kbDocuments.id, documentId))
      .limit(1);
    if (!row) {
      throw new NotFoundException('知识库文档不存在');
    }
    return row;
  }

  /** 版本行（RLS：客户仅能读到已发布文档的版本行；内部端点另行断言权限） */
  private async requireVersion(
    documentId: string,
    versionId: string,
  ): Promise<KbDocumentVersionRow> {
    const [row] = await this.db
      .select()
      .from(kbDocumentVersions)
      .where(and(eq(kbDocumentVersions.id, versionId), eq(kbDocumentVersions.documentId, documentId)))
      .limit(1);
    if (!row) {
      throw new NotFoundException('版本不存在');
    }
    return row;
  }

  /** 文档的未发布草稿版本（每文档最多一个；service 层保证） */
  private async draftVersion(documentId: string): Promise<KbDocumentVersionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(kbDocumentVersions)
      .where(and(eq(kbDocumentVersions.documentId, documentId), eq(kbDocumentVersions.isPublished, false)))
      .limit(1);
    return row;
  }

  /** 最新发布版本（versionNumber 最大；已发布/归档文档的线上内容） */
  private async latestPublishedVersion(
    documentId: string,
  ): Promise<KbDocumentVersionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(kbDocumentVersions)
      .where(and(eq(kbDocumentVersions.documentId, documentId), eq(kbDocumentVersions.isPublished, true)))
      .orderBy(desc(kbDocumentVersions.versionNumber))
      .limit(1);
    return row;
  }

  /** 版本号分配：max(versionNumber) + 1（1-based，blueprints 同构） */
  private async nextVersionNumber(documentId: string): Promise<number> {
    const [row] = await this.db
      .select({ m: max(kbDocumentVersions.versionNumber) })
      .from(kbDocumentVersions)
      .where(eq(kbDocumentVersions.documentId, documentId));
    return (row?.m ?? 0) + 1;
  }

  /** 批量查 hasDraft（已发布 + 有待发布草稿修改；列表避免 N+1） */
  private async draftDocumentIds(documentIds: string[]): Promise<Set<string>> {
    if (documentIds.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .select({ documentId: kbDocumentVersions.documentId })
      .from(kbDocumentVersions)
      .where(
        and(
          eq(kbDocumentVersions.isPublished, false),
          inArray(kbDocumentVersions.documentId, documentIds),
        ),
      );
    return new Set(rows.map((r) => r.documentId));
  }

  /** 文档行 + 创建人名 + hasDraft → 契约详情（viewerRole 由调用方补） */
  private async documentDetailBase(
    row: KbDocumentRow,
  ): Promise<KbDocumentDetailWithoutRole> {
    let createdByName: string | null = null;
    if (row.createdById) {
      const [creator] = await this.db
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, row.createdById))
        .limit(1);
      createdByName = creator?.displayName ?? null;
    }
    // hasDraft 仅语义 =「已发布 + 有待发布草稿修改」；草稿文档自身的草稿版本不算
    const hasDraft = row.status === 'published' && (await this.draftVersion(row.id)) !== undefined;
    return toDocumentDto(row, createdByName, hasDraft);
  }

  /** 组装详情内容：按状态取可见版本（草稿文档→草稿；已发布→线上；归档→最后线上） */
  private async attachContent(
    base: KbDocumentDetailWithoutRole,
    row: KbDocumentRow,
  ): Promise<KbDocumentDetailWithoutRole> {
    let visible: KbDocumentVersionRow | undefined;
    if (row.status === 'draft') {
      visible = await this.draftVersion(row.id);
    } else {
      visible = await this.latestPublishedVersion(row.id);
    }
    if (!visible) {
      return base;
    }
    if (visible.body !== null && visible.body !== undefined) {
      return { ...base, body: visible.body };
    }
    if (visible.fileName) {
      return {
        ...base,
        file: {
          id: visible.id,
          name: visible.fileName,
          contentType: visible.contentType ?? 'application/octet-stream',
          size: visible.size ?? 0,
        },
      };
    }
    return base;
  }

  // ---- 文档 ----

  /** 列表（分类筛选；内部默认不含归档，includeArchived 管理视图；客户仅已发布——RLS 兜底 + 显式过滤） */
  async listDocuments(
    actor: AuthUser,
    query: { category?: string; includeArchived?: boolean },
  ): Promise<KbListResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(actor, ctx);

    const conditions: SQL[] = [];
    if (query.category) {
      conditions.push(eq(kbDocuments.category, query.category));
    }
    if (viewerRole === 'customer') {
      conditions.push(eq(kbDocuments.status, 'published'));
    } else if (!query.includeArchived) {
      conditions.push(ne(kbDocuments.status, 'archived'));
    }

    const rows = await this.db
      .select({ document: kbDocuments, createdByName: users.displayName })
      .from(kbDocuments)
      .leftJoin(users, eq(users.id, kbDocuments.createdById))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(kbDocuments.createdAt));
    const draftIds = await this.draftDocumentIds(rows.map((r) => r.document.id));
    return {
      documents: rows.map((r) => toDocumentDto(r.document, r.createdByName, draftIds.has(r.document.id))),
      viewerRole,
    };
  }

  /** 创建文档（草稿态）：markdown 存正文 / file 解码后实测 size 存对象存储 */
  async createDocument(actor: AuthUser, input: KbCreateRequest): Promise<KbDocumentResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(actor, ctx);
    this.assertCanManage(viewerRole, '仅内部用户可维护知识库文档');

    let fileMeta: { buffer: Buffer; fileName: string; contentType: string } | undefined;
    if (input.docType === 'file') {
      const buffer = Buffer.from(input.base64, 'base64');
      if (buffer.byteLength > MAX_FILE_BYTES) {
        throw new BadRequestException('文件过大（解码后 ≤ 6MB）');
      }
      if (buffer.byteLength === 0) {
        throw new BadRequestException('文件内容不能为空');
      }
      fileMeta = { buffer, fileName: input.fileName, contentType: input.contentType };
    }

    const [row] = await this.db
      .insert(kbDocuments)
      .values({
        title: input.title,
        category: input.category,
        docType: input.docType,
        status: 'draft',
        createdById: actor.sub,
      })
      .returning();
    if (!row) {
      throw new InternalServerErrorException('创建知识库文档失败');
    }

    const version: typeof kbDocumentVersions.$inferInsert = {
      documentId: row.id,
      isPublished: false,
      title: row.title,
      category: row.category,
      ...(input.docType === 'markdown'
        ? { body: input.body ?? '' }
        : fileMeta
          ? {
              fileName: fileMeta.fileName,
              contentType: fileMeta.contentType,
              size: fileMeta.buffer.byteLength,
              storageKey: fileKey(row.id),
            }
          : {}),
    };
    const [versionRow] = await this.db.insert(kbDocumentVersions).values(version).returning();
    if (!versionRow) {
      throw new InternalServerErrorException('创建草稿版本失败');
    }
    if (fileMeta && versionRow.storageKey) {
      // DB 行先落（uuid key 已定），storage 失败时行内残留 key 指向空对象（读返回 null → 404 语义）
      await this.storage.put(versionRow.storageKey, fileMeta.buffer, {
        contentType: fileMeta.contentType,
      });
    }

    await this.audit.record(AUDIT_ACTIONS.KB_CREATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'kb_document',
      resourceId: row.id,
      metadata: { title: row.title, category: row.category, docType: row.docType },
    });
    return { document: await this.documentDetail(row.id, viewerRole) };
  }

  /** 详情（markdown 内联 body / 文件元信息 + viewerRole） */
  async getDocument(documentId: string, actor: AuthUser): Promise<KbDocumentResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(actor, ctx);
    const row = await this.requireDocument(documentId); // RLS：客户读草稿/归档 → 404
    const base = await this.documentDetailBase(row);
    const detail = await this.attachContent(base, row);
    return { document: { ...detail, viewerRole } };
  }

  /**
   * 保存草稿：草稿文档 → 直接改文档头（title/category）+ 草稿版本内容；已发布 → 更新
   * 草稿版本快照（不存在的从线上继承后派生——「重新发布才生效」，线上内容不动）；
   * 归档文档不可编辑（先恢复）。
   */
  async updateDocument(
    documentId: string,
    actor: AuthUser,
    input: KbUpdateRequest,
  ): Promise<KbDocumentResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(actor, ctx);
    this.assertCanManage(viewerRole, '仅内部用户可维护知识库文档');
    const row = await this.requireDocument(documentId);
    // 外部导入文档只读（issue #25 AC3）：在线编辑禁用，内容只能由导入通道更新
    if (row.source === 'online_help') {
      throw new BadRequestException('外部导入文档只读，不可在线编辑');
    }
    if (row.status === 'archived') {
      throw new BadRequestException('归档文档不可编辑，请先恢复');
    }

    // 文件类覆盖上传：解码实测 size，storage 对象（新 key）
    let fileMeta:
      | { buffer: Buffer; fileName: string; contentType: string; storageKey: string }
      | undefined;
    if (input.base64 !== undefined) {
      const buffer = Buffer.from(input.base64, 'base64');
      if (buffer.byteLength > MAX_FILE_BYTES) {
        throw new BadRequestException('文件过大（解码后 ≤ 6MB）');
      }
      if (buffer.byteLength === 0) {
        throw new BadRequestException('文件内容不能为空');
      }
      fileMeta = {
        buffer,
        fileName: input.fileName ?? row.title,
        contentType: input.contentType ?? 'application/octet-stream',
        storageKey: fileKey(row.id),
      };
    }

    if (row.status === 'draft') {
      // 草稿文档：直接更新文档头 + 草稿版本内容
      const [updated] = await this.db
        .update(kbDocuments)
        .set({
          title: input.title,
          category: input.category,
          updatedAt: new Date(),
        })
        .where(eq(kbDocuments.id, row.id))
        .returning();
      if (!updated) {
        throw new NotFoundException('知识库文档不存在');
      }
      const draft = await this.draftVersion(row.id);
      if (draft) {
        const set: Partial<typeof kbDocumentVersions.$inferInsert> = {
          title: input.title ?? draft.title,
          category: input.category ?? draft.category,
          ...(row.docType === 'markdown' && input.body !== undefined ? { body: input.body } : {}),
          ...(row.docType === 'file' && fileMeta
            ? {
                fileName: fileMeta.fileName,
                contentType: fileMeta.contentType,
                size: fileMeta.buffer.byteLength,
                storageKey: fileMeta.storageKey,
              }
            : {}),
        };
        await this.db
          .update(kbDocumentVersions)
          .set(set)
          .where(eq(kbDocumentVersions.id, draft.id));
        if (row.docType === 'file' && fileMeta) {
          await this.storage.put(fileMeta.storageKey, fileMeta.buffer, {
            contentType: fileMeta.contentType,
          });
        }
      }
      await this.audit.record(AUDIT_ACTIONS.KB_UPDATE, {
        actorUserId: actor.sub,
        actorRole: actor.role,
        resourceType: 'kb_document',
        resourceId: row.id,
        metadata: { title: updated.title, category: updated.category, status: 'draft' },
      });
      return { document: await this.documentDetail(row.id, viewerRole) };
    }

    // 已发布：编辑派生/更新草稿版本快照（文档头不动，线上保持）
    let draft = await this.draftVersion(row.id);
    if (!draft) {
      // 从线上版本继承未修改的字段
      const current = await this.latestPublishedVersion(row.id);
      const [created] = await this.db
        .insert(kbDocumentVersions)
        .values({
          documentId: row.id,
          isPublished: false,
          title: current?.title ?? row.title,
          category: current?.category ?? row.category,
          ...(row.docType === 'markdown'
            ? { body: current?.body ?? '' }
            : current?.fileName
              ? {
                  fileName: current.fileName,
                  contentType: current.contentType,
                  size: current.size,
                  storageKey: current.storageKey, // 未覆盖前共享线上对象（快照内容一致）
                }
              : {}),
        })
        .returning();
      if (!created) {
        throw new InternalServerErrorException('派生草稿版本失败');
      }
      draft = created;
    }
    const set: Partial<typeof kbDocumentVersions.$inferInsert> = {
      title: input.title ?? draft.title,
      category: input.category ?? draft.category,
      ...(row.docType === 'markdown' && input.body !== undefined ? { body: input.body } : {}),
      ...(row.docType === 'file' && fileMeta
        ? {
            fileName: fileMeta.fileName,
            contentType: fileMeta.contentType,
            size: fileMeta.buffer.byteLength,
            storageKey: fileMeta.storageKey,
          }
        : {}),
    };
    await this.db.update(kbDocumentVersions).set(set).where(eq(kbDocumentVersions.id, draft.id));
    if (row.docType === 'file' && fileMeta) {
      await this.storage.put(fileMeta.storageKey, fileMeta.buffer, {
        contentType: fileMeta.contentType,
      });
    }
    await this.audit.record(AUDIT_ACTIONS.KB_UPDATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'kb_document',
      resourceId: row.id,
      metadata: { title: row.title, category: row.category, status: 'published', hasPendingDraft: true },
    });
    return { document: await this.documentDetail(row.id, viewerRole) };
  }

  /** 发布/重新发布：草稿版本转正（版本号分配 + 快照写回文档头）；发布动作是 RAG 同步触发点（#21） */
  async publishDocument(documentId: string, actor: AuthUser): Promise<KbDocumentResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(actor, ctx);
    this.assertCanManage(viewerRole, '仅内部用户可维护知识库文档');
    const row = await this.requireDocument(documentId);
    if (row.status === 'archived') {
      throw new BadRequestException('归档文档需先恢复才能发布');
    }
    const draft = await this.draftVersion(row.id);
    if (row.status === 'published' && !draft) {
      throw new BadRequestException('没有待发布的修改');
    }
    const toPublish = draft;
    if (!toPublish) {
      throw new BadRequestException('没有待发布的内容'); // 草稿文档必有草稿版本（创建时生成）；数据异常兜底
    }

    const versionNumber = await this.nextVersionNumber(row.id);
    const [updated] = await this.db
      .update(kbDocumentVersions)
      .set({
        isPublished: true,
        versionNumber,
        publishedById: actor.sub,
        publishedAt: new Date(),
      })
      .where(eq(kbDocumentVersions.id, toPublish.id))
      .returning();
    if (!updated) {
      throw new NotFoundException('草稿版本不存在');
    }
    await this.db
      .update(kbDocuments)
      .set({ status: 'published', title: updated.title, category: updated.category, updatedAt: new Date() })
      .where(eq(kbDocuments.id, row.id));

    await this.audit.record(AUDIT_ACTIONS.KB_PUBLISH, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'kb_document',
      resourceId: row.id,
      metadata: { title: updated.title, toVersion: versionNumber },
    });
    // 发布 = RAG 同步触发点（#21）：事务入队（请求事务内，失败 → 发布回滚）+ 提交后唤醒
    const sync = await this.rag.enqueueInTx(this.db, {
      documentId: row.id,
      documentType: 'kb_document',
      versionNumber,
      action: 'upsert',
      scope: 'internal', // 内部 KB 文档 → 内部 Index（spec 57）
      title: updated.title,
    });
    if (sync) {
      await this.rag.notify(sync.id);
    }
    return { document: await this.documentDetail(row.id, viewerRole) };
  }

  /** 归档（仅已发布；「归档即下架」，列表默认消失；草稿版本保留，恢复后继续） */
  async archiveDocument(documentId: string, actor: AuthUser): Promise<KbDocumentResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(actor, ctx);
    this.assertCanManage(viewerRole, '仅内部用户可维护知识库文档');
    const row = await this.requireDocument(documentId);
    if (row.status !== 'published') {
      throw new BadRequestException('仅已发布文档可归档');
    }
    await this.db
      .update(kbDocuments)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(eq(kbDocuments.id, row.id));
    await this.audit.record(AUDIT_ACTIONS.KB_ARCHIVE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'kb_document',
      resourceId: row.id,
      metadata: { title: row.title },
    });
    // 归档 = RAG 删除触发点（#21）：事务入队 delete（最后发布版本 → 从 Index 下架）
    const last = await this.latestPublishedVersion(row.id);
    if (last && last.versionNumber !== null) {
      const sync = await this.rag.enqueueInTx(this.db, {
        documentId: row.id,
        documentType: 'kb_document',
        versionNumber: last.versionNumber,
        action: 'delete',
        scope: 'internal',
        title: row.title,
      });
      if (sync) {
        await this.rag.notify(sync.id);
      }
    }
    return { document: await this.documentDetail(row.id, viewerRole) };
  }

  /** 恢复（已归档 → 重新上架，线上内容 = 最后发布版本） */
  async restoreDocument(documentId: string, actor: AuthUser): Promise<KbDocumentResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(actor, ctx);
    this.assertCanManage(viewerRole, '仅内部用户可维护知识库文档');
    const row = await this.requireDocument(documentId);
    if (row.status !== 'archived') {
      throw new BadRequestException('仅已归档文档可恢复');
    }
    await this.db
      .update(kbDocuments)
      .set({ status: 'published', updatedAt: new Date() })
      .where(eq(kbDocuments.id, row.id));
    await this.audit.record(AUDIT_ACTIONS.KB_RESTORE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'kb_document',
      resourceId: row.id,
      metadata: { title: row.title },
    });
    // 恢复 = 重新上架（#21）：事务入队 upsert 最后发布版本 → 重新导入 Index
    const last = await this.latestPublishedVersion(row.id);
    if (last && last.versionNumber !== null) {
      const sync = await this.rag.enqueueInTx(this.db, {
        documentId: row.id,
        documentType: 'kb_document',
        versionNumber: last.versionNumber,
        action: 'upsert',
        scope: 'internal',
        title: row.title,
      });
      if (sync) {
        await this.rag.notify(sync.id);
      }
    }
    return { document: await this.documentDetail(row.id, viewerRole) };
  }

  // ---- 版本 ----

  /** 版本历史（内部端点）：发布版本倒序 + 当前草稿版本置顶标注 */
  async listVersions(documentId: string, actor: AuthUser): Promise<KbVersionsResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(actor, ctx);
    this.assertCanManage(viewerRole, '仅内部用户可维护知识库文档');
    await this.requireDocument(documentId);

    const rows = await this.db
      .select({ version: kbDocumentVersions, publishedByName: users.displayName })
      .from(kbDocumentVersions)
      .leftJoin(users, eq(users.id, kbDocumentVersions.publishedById))
      .where(eq(kbDocumentVersions.documentId, documentId))
      .orderBy(desc(kbDocumentVersions.isPublished), desc(kbDocumentVersions.versionNumber));
    return { versions: rows.map((r) => toVersionDto(r.version, r.publishedByName)) };
  }

  /** 版本内容回看（内部）：markdown → {body}；文件 → 字节流下载 */
  async getVersionContent(
    documentId: string,
    versionId: string,
    actor: AuthUser,
  ): Promise<
    { kind: 'markdown'; body: string } | { kind: 'file'; buffer: Buffer; name: string; contentType: string }
  > {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(actor, ctx);
    this.assertCanManage(viewerRole, '仅内部用户可维护知识库文档');
    await this.requireDocument(documentId);
    const version = await this.requireVersion(documentId, versionId);

    if (version.fileName && version.storageKey) {
      const buffer = await this.storage.get(version.storageKey);
      if (!buffer) {
        throw new NotFoundException('文件内容不存在');
      }
      return {
        kind: 'file',
        buffer,
        name: version.fileName,
        contentType: version.contentType ?? 'application/octet-stream',
      };
    }
    return { kind: 'markdown', body: version.body ?? '' };
  }

  /** 文件类当前线上内容下载（客户 = 已发布文档；RLS 兜底） */
  async getDocumentContent(
    documentId: string,
    actor: AuthUser,
  ): Promise<{ buffer: Buffer; name: string; contentType: string }> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.resolveViewerRole(actor, ctx);
    const row = await this.requireDocument(documentId);
    let visible: KbDocumentVersionRow | undefined;
    if (row.status === 'draft') {
      visible = await this.draftVersion(row.id);
    } else {
      visible = await this.latestPublishedVersion(row.id);
    }
    if (!visible || !visible.fileName || !visible.storageKey) {
      throw new BadRequestException('该文档不是文件类文档或暂无内容');
    }
    const buffer = await this.storage.get(visible.storageKey);
    if (!buffer) {
      throw new NotFoundException('文件内容不存在');
    }
    return {
      buffer,
      name: visible.fileName,
      contentType: visible.contentType ?? 'application/octet-stream',
    };
  }

  /** 详情组装（各端点统一入口；viewerRole 一并带上） */
  private async documentDetail(
    documentId: string,
    viewerRole: KbViewerRole,
  ): Promise<KbDocumentDetail> {
    const row = await this.requireDocument(documentId);
    const base = await this.documentDetailBase(row);
    const detail = await this.attachContent(base, row);
    return { ...detail, viewerRole };
  }
}

/** DB 行 → 契约 KbDocument（列表/详情公共部分；viewerRole 由调用方补） */
function toDocumentDto(
  row: KbDocumentRow,
  createdByName: string | null,
  hasDraft: boolean,
): KbDocumentDetailWithoutRole {
  return {
    id: row.id,
    title: row.title,
    category: row.category as KbDocumentDetail['category'],
    docType: row.docType as KbDocumentDetail['docType'],
    source: row.source as KbDocumentDetail['source'],
    status: row.status as KbDocumentDetail['status'],
    hasDraft,
    createdBy: row.createdById ? { id: row.createdById, displayName: createdByName ?? '' } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 版本行 → 契约 KbVersion（file 快照：版本行 id 即文件 id） */
function toVersionDto(row: KbDocumentVersionRow, publishedByName: string | null): KbVersion {
  return {
    id: row.id,
    documentId: row.documentId,
    versionNumber: row.versionNumber,
    title: row.title,
    category: row.category as KbVersion['category'],
    ...(row.fileName
      ? {
          file: {
            id: row.id,
            name: row.fileName,
            contentType: row.contentType ?? 'application/octet-stream',
            size: row.size ?? 0,
          },
        }
      : row.body !== null && row.body !== undefined
        ? { body: row.body }
        : {}),
    publishedBy: row.publishedById
      ? { id: row.publishedById, displayName: publishedByName ?? '' }
      : null,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
