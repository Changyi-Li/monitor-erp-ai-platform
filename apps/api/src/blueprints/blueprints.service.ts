import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, max } from 'drizzle-orm';
import {
  type Blueprint,
  type BlueprintCreateRequest,
  type BlueprintGetResponse,
  type BlueprintPublishResponse,
  type BlueprintUpdateRequest,
  type BlueprintUpdateResponse,
  type BlueprintVersion,
  type BlueprintVersionGetResponse,
  type BlueprintVersionsListResponse,
  type ProjectViewerRole,
} from '@monitor/contracts';
import { can } from '@monitor/shared';
import { STORAGE } from '../adapters/storage/storage.module';
import type { StoragePort } from '../adapters/storage/storage.port';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/current-user.decorator';
import { DRIZZLE, type Database } from '../database/database.module';
import {
  blueprintVersions,
  blueprints,
  projects,
  users,
  type BlueprintRow,
  type BlueprintVersionRow,
} from '../database/schema';
import { TenantContextService, type TenantContext } from '../database/tenant-context.service';
import { MembersService } from '../projects/members.service';
import { RagSyncService } from '../rag/rag-sync.service';

/** base64 解码上限：DrawioUploadSchema.base64 ≤ 8_000_000 字符 ≈ 6MB 二进制 */
const MAX_DRAWIO_BYTES = 6_000_000;

/** 文件对象存储 key：当前工作文件 + 每版本一份（版本 key 冻结，快照不可变） */
const currentKey = (blueprintId: string) => `blueprints/${blueprintId}/current.drawio`;
const versionKey = (blueprintId: string, version: number) =>
  `blueprints/${blueprintId}/v${version}.drawio`;

/**
 * 蓝图（issue #16，spec §3.2）：一个项目一份 + 版本快照。
 * 两层边界（与 issues 同构）：租户 RLS 兜底（跨租户 → 404 防探测）+ 应用层项目成员校验
 * （同租户非成员 → 403）。查看 = 项目成员（blueprint:view 全员）；维护（创建/编辑/发布）
 * = 仅内部/超管（blueprint:manage，spec §2.4 蓝图维护仅内部）。
 * 文件经 StoragePort 存对象存储（memory adapter 为开发默认，切 S3 只改配置），
 * DB 存 key + 元信息；发布 = 把当前内容（字段 + 文件）整体快照成新版本。
 */
@Injectable()
export class BlueprintsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(STORAGE) private readonly storage: StoragePort,
    private readonly tenantContext: TenantContextService,
    private readonly members: MembersService,
    private readonly audit: AuditService,
    private readonly rag: RagSyncService,
  ) {}

  /** 项目准入：内部 → 'internal'；客户用户须为该项目 active 成员（非成员 → 403） */
  private async resolveViewerRole(
    projectId: string,
    ctx: TenantContext,
  ): Promise<ProjectViewerRole> {
    if (ctx.isInternal) {
      return 'internal';
    }
    const role = await this.members.resolveViewerRole(projectId, ctx.userId);
    if (!role) {
      throw new ForbiddenException('你不是该项目成员');
    }
    return role;
  }

  /** 项目存在性（RLS 过滤：客户用户跨租户项目 → 404 防探测） */
  private async requireProject(projectId: string): Promise<{ id: string; tenantId: string }> {
    const [project] = await this.db
      .select({ id: projects.id, tenantId: projects.tenantId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) {
      throw new NotFoundException('项目不存在');
    }
    return project;
  }

  /** 蓝图行（项目维度唯一；不存在 → 404） */
  private async requireBlueprint(projectId: string): Promise<BlueprintRow> {
    const [row] = await this.db
      .select()
      .from(blueprints)
      .where(eq(blueprints.projectId, projectId))
      .limit(1);
    if (!row) {
      throw new NotFoundException('该项目尚未创建蓝图');
    }
    return row;
  }

  /** 角色级权限检查（viewerRole 为 null 时 fail closed） */
  private assertPermission(
    viewerRole: ProjectViewerRole,
    permission: 'blueprint:view' | 'blueprint:manage',
    message: string,
  ): void {
    if (!can(viewerRole, permission)) {
      throw new ForbiddenException(message);
    }
  }

  /** base64 解码 + 大小校验（decode 后按字节限，不信任客户端 size） */
  private decodeDrawio(base64: string): Buffer {
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > MAX_DRAWIO_BYTES) {
      throw new BadRequestException('draw.io 文件过大（解码后不得超过 6MB）');
    }
    if (buffer.length === 0) {
      throw new BadRequestException('draw.io 文件内容为空');
    }
    return buffer;
  }

  /** 已发布版本数（latestVersion；未发布 → null） */
  private async latestVersionOf(blueprintId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ v: max(blueprintVersions.version) })
      .from(blueprintVersions)
      .where(eq(blueprintVersions.blueprintId, blueprintId));
    return row?.v ?? null;
  }

  /** 蓝图 + viewerRole（未创建 → blueprint: null，前端显示创建表单） */
  async get(projectId: string, actor: AuthUser): Promise<BlueprintGetResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);

    const [row] = await this.db
      .select()
      .from(blueprints)
      .where(eq(blueprints.projectId, projectId))
      .limit(1);
    if (!row) {
      return { blueprint: null, viewerRole };
    }
    return { blueprint: toBlueprintDto(row, await this.latestVersionOf(row.id)), viewerRole };
  }

  /** 首次创建（验收①：上传 draw.io + 结构化内容 → 自动发布 v1 快照）；已存在 → 409 */
  async create(
    projectId: string,
    actor: AuthUser,
    input: BlueprintCreateRequest,
  ): Promise<BlueprintPublishResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const project = await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'blueprint:manage', '仅内部用户可创建蓝图');

    const existing = await this.db
      .select({ id: blueprints.id })
      .from(blueprints)
      .where(eq(blueprints.projectId, projectId))
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictException('该项目已创建蓝图，请编辑后发布新版本');
    }
    const buffer = this.decodeDrawio(input.drawio.base64);

    const [row] = await this.db
      .insert(blueprints)
      .values({
        tenantId: project.tenantId,
        projectId,
        businessRequirements: input.businessRequirements ?? null,
        moduleScope: input.moduleScope ?? null,
        configNotes: input.configNotes ?? null,
        processDescription: input.processDescription ?? null,
        drawioKey: currentKey(projectId), // key 按 projectId 定位（与 blueprint 行一一对应）
        drawioName: input.drawio.name,
        drawioContentType: input.drawio.contentType,
        drawioSize: buffer.length,
      })
      .returning();
    if (!row) {
      throw new InternalServerErrorException('创建蓝图失败');
    }
    await this.storage.put(row.drawioKey, buffer, { contentType: row.drawioContentType });
    await this.storage.put(versionKey(row.id, 1), buffer, {
      contentType: row.drawioContentType,
    });

    const [version] = await this.db
      .insert(blueprintVersions)
      .values({
        tenantId: row.tenantId,
        blueprintId: row.id,
        version: 1,
        businessRequirements: row.businessRequirements,
        moduleScope: row.moduleScope,
        configNotes: row.configNotes,
        processDescription: row.processDescription,
        drawioKey: versionKey(row.id, 1),
        drawioName: row.drawioName,
        drawioContentType: row.drawioContentType,
        drawioSize: row.drawioSize,
        publishedBy: actor.sub,
      })
      .returning();
    if (!version) {
      throw new InternalServerErrorException('发布蓝图失败');
    }
    await this.audit.record(AUDIT_ACTIONS.BLUEPRINT_CREATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'blueprint',
      resourceId: row.id,
      metadata: { projectId, version: 1 },
    });
    // 创建即发布 v1 → RAG 同步入队（#21：客户项目文档 → 客户 Index）
    await this.enqueueBlueprintSync(row.id, row.tenantId, 1, row.drawioName);
    return {
      blueprint: toBlueprintDto(row, 1),
      version: toVersionDto(version, await this.publisherName(actor.sub)),
    };
  }

  /** RAG 同步入队（#21，spec 57 scope 路由）：蓝图发布/创建 → 客户 Index（事务入队 + 提交后唤醒） */
  private async enqueueBlueprintSync(
    blueprintId: string,
    tenantId: string,
    versionNumber: number,
    drawioName: string,
  ): Promise<void> {
    const sync = await this.rag.enqueueInTx(this.db, {
      documentId: blueprintId,
      documentType: 'blueprint',
      versionNumber,
      action: 'upsert',
      scope: 'customer',
      tenantId,
      title: drawioName,
    });
    if (sync) {
      await this.rag.notify(sync.id);
    }
  }

  /** 编辑当前内容（部分更新；drawio 可选——不带则保留现有文件） */
  async update(
    projectId: string,
    actor: AuthUser,
    input: BlueprintUpdateRequest,
  ): Promise<BlueprintUpdateResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'blueprint:manage', '仅内部用户可编辑蓝图');

    const row = await this.requireBlueprint(projectId);
    if (
      input.businessRequirements === undefined &&
      input.moduleScope === undefined &&
      input.configNotes === undefined &&
      input.processDescription === undefined &&
      input.drawio === undefined
    ) {
      return { blueprint: toBlueprintDto(row, await this.latestVersionOf(row.id)) }; // 空对象 = 无操作
    }

    let drawioKey = row.drawioKey;
    let drawioName = row.drawioName;
    let drawioContentType = row.drawioContentType;
    let drawioSize = row.drawioSize;
    if (input.drawio) {
      const buffer = this.decodeDrawio(input.drawio.base64);
      drawioKey = currentKey(row.id);
      drawioName = input.drawio.name;
      drawioContentType = input.drawio.contentType;
      drawioSize = buffer.length;
      await this.storage.put(drawioKey, buffer, { contentType: drawioContentType });
    }

    const [updated] = await this.db
      .update(blueprints)
      .set({
        businessRequirements: input.businessRequirements,
        moduleScope: input.moduleScope,
        configNotes: input.configNotes,
        processDescription: input.processDescription,
        drawioKey,
        drawioName,
        drawioContentType,
        drawioSize,
        updatedAt: new Date(),
      })
      .where(eq(blueprints.id, row.id))
      .returning();
    if (!updated) {
      throw new NotFoundException('蓝图不存在');
    }
    await this.audit.record(AUDIT_ACTIONS.BLUEPRINT_UPDATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'blueprint',
      resourceId: row.id,
      metadata: { projectId, changedFields: listChangedFields(input, row) },
    });
    return { blueprint: toBlueprintDto(updated, await this.latestVersionOf(updated.id)) };
  }

  /** 发布新版本（验收②：编辑 → 发布 → 版本历史 v1/v2…；快照 = 字段 + 文件一致） */
  async publish(projectId: string, actor: AuthUser): Promise<BlueprintPublishResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'blueprint:manage', '仅内部用户可发布蓝图');

    const row = await this.requireBlueprint(projectId);
    const from = await this.latestVersionOf(row.id);

    const buffer = await this.storage.get(row.drawioKey);
    if (!buffer) {
      throw new BadRequestException('未找到流程图文件，无法发布');
    }

    const next = (from ?? 0) + 1;
    const key = versionKey(row.id, next);
    await this.storage.put(key, buffer, { contentType: row.drawioContentType });

    const [version] = await this.db
      .insert(blueprintVersions)
      .values({
        tenantId: row.tenantId,
        blueprintId: row.id,
        version: next,
        businessRequirements: row.businessRequirements,
        moduleScope: row.moduleScope,
        configNotes: row.configNotes,
        processDescription: row.processDescription,
        drawioKey: key,
        drawioName: row.drawioName,
        drawioContentType: row.drawioContentType,
        drawioSize: row.drawioSize,
        publishedBy: actor.sub,
      })
      .returning();
    if (!version) {
      throw new InternalServerErrorException('发布蓝图失败');
    }
    await this.audit.record(AUDIT_ACTIONS.BLUEPRINT_PUBLISH, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'blueprint',
      resourceId: row.id,
      metadata: { projectId, fromVersion: from, toVersion: next },
    });
    // 蓝图发布 = RAG 同步触发点（#21）：客户项目文档 → 客户 Index（spec 57 scope 路由）
    await this.enqueueBlueprintSync(row.id, row.tenantId, next, row.drawioName);
    return {
      blueprint: toBlueprintDto(row, next),
      version: toVersionDto(version, await this.publisherName(actor.sub)),
    };
  }

  /** 版本历史（viewerRole 非 null 均可看；未创建蓝图 → 空列表） */
  async listVersions(
    projectId: string,
    actor: AuthUser,
  ): Promise<BlueprintVersionsListResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId);
    await this.resolveViewerRole(projectId, ctx);

    const [blueprint] = await this.db
      .select({ id: blueprints.id })
      .from(blueprints)
      .where(eq(blueprints.projectId, projectId))
      .limit(1);
    if (!blueprint) {
      return { versions: [] };
    }
    const rows = await this.db
      .select({
        id: blueprintVersions.id,
        blueprintId: blueprintVersions.blueprintId,
        version: blueprintVersions.version,
        businessRequirements: blueprintVersions.businessRequirements,
        moduleScope: blueprintVersions.moduleScope,
        configNotes: blueprintVersions.configNotes,
        processDescription: blueprintVersions.processDescription,
        drawioKey: blueprintVersions.drawioKey,
        drawioName: blueprintVersions.drawioName,
        drawioContentType: blueprintVersions.drawioContentType,
        drawioSize: blueprintVersions.drawioSize,
        publishedBy: blueprintVersions.publishedBy,
        publishedAt: blueprintVersions.publishedAt,
        publisherName: users.displayName,
      })
      .from(blueprintVersions)
      .leftJoin(users, eq(users.id, blueprintVersions.publishedBy))
      .where(eq(blueprintVersions.blueprintId, blueprint.id))
      .orderBy(blueprintVersions.version);
    return { versions: rows.map((r) => toVersionDto(r, r.publisherName)) };
  }

  /** 历史版本回看（验收③；版本快照不可变） */
  async getVersion(
    projectId: string,
    version: number,
    actor: AuthUser,
  ): Promise<BlueprintVersionGetResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId);
    await this.resolveViewerRole(projectId, ctx);
    const blueprint = await this.requireBlueprint(projectId);

    const [row] = await this.db
      .select({
        id: blueprintVersions.id,
        blueprintId: blueprintVersions.blueprintId,
        version: blueprintVersions.version,
        businessRequirements: blueprintVersions.businessRequirements,
        moduleScope: blueprintVersions.moduleScope,
        configNotes: blueprintVersions.configNotes,
        processDescription: blueprintVersions.processDescription,
        drawioKey: blueprintVersions.drawioKey,
        drawioName: blueprintVersions.drawioName,
        drawioContentType: blueprintVersions.drawioContentType,
        drawioSize: blueprintVersions.drawioSize,
        publishedBy: blueprintVersions.publishedBy,
        publishedAt: blueprintVersions.publishedAt,
        publisherName: users.displayName,
      })
      .from(blueprintVersions)
      .leftJoin(users, eq(users.id, blueprintVersions.publishedBy))
      .where(and(eq(blueprintVersions.blueprintId, blueprint.id), eq(blueprintVersions.version, version)))
      .limit(1);
    if (!row) {
      throw new NotFoundException('蓝图版本不存在');
    }
    return { version: toVersionDto(row, row.publisherName) };
  }

  /** 下载原文件（验收③：可下载；返回字节 + 元信息，controller 设响应头） */
  async getVersionFile(
    projectId: string,
    version: number,
    actor: AuthUser,
  ): Promise<{ buffer: Buffer; name: string; contentType: string }> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId);
    await this.resolveViewerRole(projectId, ctx);
    const blueprint = await this.requireBlueprint(projectId);

    const [row] = await this.db
      .select({
        drawioKey: blueprintVersions.drawioKey,
        drawioName: blueprintVersions.drawioName,
        drawioContentType: blueprintVersions.drawioContentType,
      })
      .from(blueprintVersions)
      .where(and(eq(blueprintVersions.blueprintId, blueprint.id), eq(blueprintVersions.version, version)))
      .limit(1);
    if (!row) {
      throw new NotFoundException('蓝图版本不存在');
    }
    const buffer = await this.storage.get(row.drawioKey);
    if (!buffer) {
      throw new NotFoundException('文件不存在');
    }
    return { buffer, name: row.drawioName, contentType: row.drawioContentType };
  }

  /** 发布人姓名（用户已删 → null 显示「已删除」） */
  private async publisherName(userId: string): Promise<string | null> {
    const [user] = await this.db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return user?.displayName ?? null;
  }
}

/** DB 行 → 契约 Blueprint（drawio 元信息；latestVersion 已发布数） */
function toBlueprintDto(row: BlueprintRow, latestVersion: number | null): Blueprint {
  return {
    id: row.id,
    projectId: row.projectId,
    businessRequirements: row.businessRequirements,
    moduleScope: row.moduleScope,
    configNotes: row.configNotes,
    processDescription: row.processDescription,
    drawio: {
      id: row.id,
      name: row.drawioName,
      contentType: row.drawioContentType,
      size: row.drawioSize,
    },
    latestVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 版本行（join users 带发布人名）→ 契约 BlueprintVersion */
function toVersionDto(
  row: Pick<
    BlueprintVersionRow,
    | 'id'
    | 'blueprintId'
    | 'version'
    | 'businessRequirements'
    | 'moduleScope'
    | 'configNotes'
    | 'processDescription'
    | 'drawioName'
    | 'drawioContentType'
    | 'drawioSize'
    | 'publishedBy'
    | 'publishedAt'
  >,
  publisherName: string | null,
): BlueprintVersion {
  return {
    id: row.id,
    blueprintId: row.blueprintId,
    version: row.version,
    businessRequirements: row.businessRequirements,
    moduleScope: row.moduleScope,
    configNotes: row.configNotes,
    processDescription: row.processDescription,
    drawio: {
      id: row.id,
      name: row.drawioName,
      contentType: row.drawioContentType,
      size: row.drawioSize,
    },
    publishedBy: row.publishedBy ? { id: row.publishedBy, displayName: publisherName ?? '' } : null,
    publishedAt: row.publishedAt.toISOString(),
  };
}

/** 编辑审计：变更了哪些字段（不含文件） */
function listChangedFields(input: BlueprintUpdateRequest, row: BlueprintRow): string[] {
  const changed: string[] = [];
  if (input.businessRequirements !== undefined && input.businessRequirements !== row.businessRequirements) {
    changed.push('businessRequirements');
  }
  if (input.moduleScope !== undefined && input.moduleScope !== row.moduleScope) {
    changed.push('moduleScope');
  }
  if (input.configNotes !== undefined && input.configNotes !== row.configNotes) {
    changed.push('configNotes');
  }
  if (input.processDescription !== undefined && input.processDescription !== row.processDescription) {
    changed.push('processDescription');
  }
  if (input.drawio) {
    changed.push('drawio');
  }
  return changed;
}
