import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  type Attachment,
  type AttachmentResponse,
  type AttachmentUpload,
  type MeetingMinute,
  type MinuteCreateRequest,
  type MinuteGetResponse,
  type MinuteResponse,
  type MinuteUpdateRequest,
  type MinutesListResponse,
  type ProjectViewerRole,
} from '@monitor/contracts';
import { can } from '@monitor/shared';
import { STORAGE } from '../adapters/storage/storage.module';
import type { StoragePort } from '../adapters/storage/storage.port';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/current-user.decorator';
import { DRIZZLE, type Database } from '../database/database.module';
import {
  meetingMinutes,
  minuteAttachments,
  projects,
  users,
  type MeetingMinuteRow,
  type MinuteAttachmentRow,
} from '../database/schema';
import { TenantContextService, type TenantContext } from '../database/tenant-context.service';
import { MembersService } from '../projects/members.service';

/** base64 解码上限：AttachmentUploadSchema.base64 ≤ 8_000_000 字符 ≈ 6MB 二进制（同 drawio） */
const MAX_ATTACHMENT_BYTES = 6_000_000;

/** 附件对象存储 key：按纪要隔离（uuid 天然不重复） */
const attachmentKey = (minuteId: string, attachmentId: string) =>
  `minutes/${minuteId}/${attachmentId}`;

/**
 * 会议纪要（issue #18，spec §3.4，数据边界 = 项目）。
 * 两层边界（与 issues/blueprints 同构）：租户 RLS 兜底（跨租户 → 404 防探测）+
 * 应用层项目成员校验（同租户非成员 → 403）。项目级权限全部在 service 层按成员表解析：
 * 查看=全员（meeting:view，spec §2.4）、维护=仅内部（meeting:manage）。
 * 附件经 StoragePort 存对象存储（memory adapter 为开发默认，切 S3 只改配置），
 * DB 只存 key + 元信息（同蓝图 drawio 模式）。
 */
@Injectable()
export class MinutesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(STORAGE) private readonly storage: StoragePort,
    private readonly tenantContext: TenantContextService,
    private readonly members: MembersService,
    private readonly audit: AuditService,
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

  /** 纪要行（RLS + 路径 projectId 双重匹配，跨项目/跨租户 → 404） */
  private async requireMinute(projectId: string, minuteId: string): Promise<MeetingMinuteRow> {
    const [row] = await this.db
      .select()
      .from(meetingMinutes)
      .where(and(eq(meetingMinutes.id, minuteId), eq(meetingMinutes.projectId, projectId)))
      .limit(1);
    if (!row) {
      throw new NotFoundException('会议纪要不存在');
    }
    return row;
  }

  /** 附件行（RLS + 路径 minuteId 双重匹配，跨纪要/跨租户 → 404） */
  private async requireAttachment(
    minuteId: string,
    attachmentId: string,
  ): Promise<MinuteAttachmentRow> {
    const [row] = await this.db
      .select()
      .from(minuteAttachments)
      .where(and(eq(minuteAttachments.id, attachmentId), eq(minuteAttachments.minuteId, minuteId)))
      .limit(1);
    if (!row) {
      throw new NotFoundException('附件不存在');
    }
    return row;
  }

  /** 角色级权限检查（viewerRole 为 null 时 fail closed） */
  private assertPermission(
    viewerRole: ProjectViewerRole,
    permission: 'meeting:view' | 'meeting:manage',
    message: string,
  ): void {
    if (!can(viewerRole, permission)) {
      throw new ForbiddenException(message);
    }
  }

  // ---- 纪要 ----

  /** 列表（spec §3.4；会议日期倒序，同日期按创建时间倒序；attachments 内联供附件数展示） */
  async listMinutes(projectId: string, actor: AuthUser): Promise<MinutesListResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'meeting:view', '你不是该项目成员');

    const rows = await this.db
      .select({ minute: meetingMinutes, createdByName: users.displayName })
      .from(meetingMinutes)
      .leftJoin(users, eq(users.id, meetingMinutes.createdById))
      .where(eq(meetingMinutes.projectId, projectId))
      .orderBy(desc(meetingMinutes.meetingDate), desc(meetingMinutes.createdAt));
    const attachments = await this.attachmentsForMinutes(rows.map((r) => r.minute.id));
    return {
      minutes: rows.map((r) => toMinuteDto(r.minute, r.createdByName, attachments.get(r.minute.id) ?? [])),
      viewerRole,
    };
  }

  /** 创建纪要（结构化字段 + 富文本正文；创建人 = 当前用户） */
  async createMinute(
    projectId: string,
    actor: AuthUser,
    input: MinuteCreateRequest,
  ): Promise<MinuteResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const project = await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'meeting:manage', '仅内部用户可维护会议纪要');

    const [row] = await this.db
      .insert(meetingMinutes)
      .values({
        tenantId: project.tenantId,
        projectId,
        title: input.title,
        meetingDate: input.meetingDate,
        participants: input.participants ?? null,
        body: input.body ?? null,
        createdById: actor.sub,
      })
      .returning();
    if (!row) {
      throw new InternalServerErrorException('创建会议纪要失败');
    }
    const [creator] = await this.db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, actor.sub))
      .limit(1);
    await this.audit.record(AUDIT_ACTIONS.MINUTE_CREATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'meeting_minute',
      resourceId: row.id,
      metadata: { projectId, title: row.title, meetingDate: row.meetingDate },
    });
    return { minute: toMinuteDto(row, creator?.displayName ?? null, []) };
  }

  /** 详情（附件内联 + 创建人名） */
  async getMinute(
    projectId: string,
    minuteId: string,
    actor: AuthUser,
  ): Promise<MinuteGetResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId); // 跨租户 → 404（resolveViewerRole 前，防探测语义同列表）
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'meeting:view', '你不是该项目成员');

    const minute = await this.requireMinute(projectId, minuteId);
    let createdByName: string | null = null;
    if (minute.createdById) {
      const [createdBy] = await this.db
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, minute.createdById))
        .limit(1);
      createdByName = createdBy?.displayName ?? null;
    }
    const attachments = await this.attachmentsForMinutes([minute.id]);
    return {
      minute: toMinuteDto(minute, createdByName, attachments.get(minute.id) ?? []),
      viewerRole,
    };
  }

  /** 编辑（部分更新：undefined 不动、null 清空 participants/body；空对象=无操作） */
  async updateMinute(
    projectId: string,
    minuteId: string,
    actor: AuthUser,
    input: MinuteUpdateRequest,
  ): Promise<MinuteResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId); // 跨租户 → 404（resolveViewerRole 前，防探测语义同列表）
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'meeting:manage', '仅内部用户可维护会议纪要');

    const minute = await this.requireMinute(projectId, minuteId);
    if (
      input.title === undefined &&
      input.meetingDate === undefined &&
      input.participants === undefined &&
      input.body === undefined
    ) {
      return { minute: await this.minuteWithNames(minute.id) }; // 空对象 = 无操作
    }
    const [row] = await this.db
      .update(meetingMinutes)
      .set({
        title: input.title,
        meetingDate: input.meetingDate,
        participants: input.participants,
        body: input.body,
        updatedAt: new Date(),
      })
      .where(and(eq(meetingMinutes.id, minute.id), eq(meetingMinutes.projectId, projectId)))
      .returning();
    if (!row) {
      throw new NotFoundException('会议纪要不存在');
    }
    await this.audit.record(AUDIT_ACTIONS.MINUTE_UPDATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'meeting_minute',
      resourceId: row.id,
      metadata: { projectId, title: row.title, meetingDate: row.meetingDate },
    });
    return { minute: await this.minuteWithNames(row.id) };
  }

  /** 删除纪要（验收①；先删 storage 附件对象，附件行由 FK 级联删） */
  async deleteMinute(projectId: string, minuteId: string, actor: AuthUser): Promise<void> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId); // 跨租户 → 404（resolveViewerRole 前，防探测语义同列表）
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'meeting:manage', '仅内部用户可维护会议纪要');

    const minute = await this.requireMinute(projectId, minuteId);
    const attachments = await this.db
      .select()
      .from(minuteAttachments)
      .where(eq(minuteAttachments.minuteId, minute.id));
    for (const att of attachments) {
      await this.storage.delete(att.storageKey);
    }
    const [deleted] = await this.db
      .delete(meetingMinutes)
      .where(and(eq(meetingMinutes.id, minute.id), eq(meetingMinutes.projectId, projectId)))
      .returning({ id: meetingMinutes.id });
    if (!deleted) {
      throw new NotFoundException('会议纪要不存在');
    }
    await this.audit.record(AUDIT_ACTIONS.MINUTE_DELETE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'meeting_minute',
      resourceId: minute.id,
      metadata: { projectId, title: minute.title, attachments: attachments.length },
    });
  }

  // ---- 附件 ----

  /** 上传附件（验收②：base64 解码后按字节实测 size，不信任客户端；存对象存储 + 元信息行） */
  async uploadAttachment(
    projectId: string,
    minuteId: string,
    actor: AuthUser,
    input: AttachmentUpload,
  ): Promise<AttachmentResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId); // 跨租户 → 404（resolveViewerRole 前，防探测语义同列表）
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'meeting:manage', '仅内部用户可维护会议纪要');

    const minute = await this.requireMinute(projectId, minuteId);
    const buffer = Buffer.from(input.base64, 'base64');
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException('附件过大（解码后 ≤ 6MB）');
    }
    if (buffer.byteLength === 0) {
      throw new BadRequestException('文件内容不能为空');
    }

    const [row] = await this.db
      .insert(minuteAttachments)
      .values({
        tenantId: minute.tenantId,
        minuteId: minute.id,
        name: input.name,
        contentType: input.contentType,
        size: buffer.byteLength,
        storageKey: attachmentKey(minute.id, crypto.randomUUID()),
      })
      .returning();
    if (!row) {
      throw new InternalServerErrorException('上传附件失败');
    }
    // DB 行先落（uuid key 已定），storage 失败时行内残留 key 指向空对象（读返回 null → 404 语义）
    await this.storage.put(row.storageKey, buffer, { contentType: input.contentType });
    await this.audit.record(AUDIT_ACTIONS.ATTACHMENT_UPLOAD, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'minute_attachment',
      resourceId: row.id,
      metadata: { projectId, minuteId: minute.id, name: row.name, size: row.size },
    });
    return { attachment: toAttachmentDto(row) };
  }

  /** 删除附件（storage 对象 + 元信息行） */
  async deleteAttachment(
    projectId: string,
    minuteId: string,
    attachmentId: string,
    actor: AuthUser,
  ): Promise<void> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId); // 跨租户 → 404（resolveViewerRole 前，防探测语义同列表）
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'meeting:manage', '仅内部用户可维护会议纪要');

    // 先经纪要存在性校验（附件行 RLS + minuteId 双匹配已含项目维度）
    await this.requireMinute(projectId, minuteId);
    const attachment = await this.requireAttachment(minuteId, attachmentId);
    await this.storage.delete(attachment.storageKey);
    const [deleted] = await this.db
      .delete(minuteAttachments)
      .where(and(eq(minuteAttachments.id, attachment.id), eq(minuteAttachments.minuteId, minuteId)))
      .returning({ id: minuteAttachments.id });
    if (!deleted) {
      throw new NotFoundException('附件不存在');
    }
    await this.audit.record(AUDIT_ACTIONS.ATTACHMENT_DELETE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'minute_attachment',
      resourceId: attachment.id,
      metadata: { projectId, minuteId, name: attachment.name },
    });
  }

  /** 附件下载（验收②/③：客户用户可下载；字节流 + 原文件名；storage 缺失 → 404） */
  async getAttachmentFile(
    projectId: string,
    minuteId: string,
    attachmentId: string,
    actor: AuthUser,
  ): Promise<{ buffer: Buffer; name: string; contentType: string }> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId); // 跨租户 → 404（resolveViewerRole 前，防探测语义同列表）
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'meeting:view', '你不是该项目成员');

    await this.requireMinute(projectId, minuteId);
    const attachment = await this.requireAttachment(minuteId, attachmentId);
    const buffer = await this.storage.get(attachment.storageKey);
    if (!buffer) {
      throw new NotFoundException('附件内容不存在');
    }
    return { buffer, name: attachment.name, contentType: attachment.contentType };
  }

  /** 纪要行 + join 创建人名 + 附件 */
  private async minuteWithNames(minuteId: string): Promise<MeetingMinute> {
    const [row] = await this.db
      .select({ minute: meetingMinutes, createdByName: users.displayName })
      .from(meetingMinutes)
      .leftJoin(users, eq(users.id, meetingMinutes.createdById))
      .where(eq(meetingMinutes.id, minuteId))
      .limit(1);
    if (!row) {
      throw new NotFoundException('会议纪要不存在');
    }
    const attachments = await this.attachmentsForMinutes([minuteId]);
    return toMinuteDto(row.minute, row.createdByName, attachments.get(minuteId) ?? []);
  }

  /** 批量取附件（按纪要分组，避免列表 N+1） */
  private async attachmentsForMinutes(
    minuteIds: string[],
  ): Promise<Map<string, MinuteAttachmentRow[]>> {
    if (minuteIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .select()
      .from(minuteAttachments)
      .where(inArray(minuteAttachments.minuteId, minuteIds))
      .orderBy(minuteAttachments.createdAt);
    const byMinute = new Map<string, MinuteAttachmentRow[]>();
    for (const row of rows) {
      const list = byMinute.get(row.minuteId) ?? [];
      list.push(row);
      byMinute.set(row.minuteId, list);
    }
    return byMinute;
  }
}

/** DB 行 → 契约 MeetingMinute：Date → toISOString；date 列本身是 'YYYY-MM-DD' 字符串 */
function toMinuteDto(
  row: MeetingMinuteRow,
  createdByName: string | null,
  attachments: MinuteAttachmentRow[],
): MeetingMinute {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    meetingDate: row.meetingDate,
    participants: row.participants ?? null,
    body: row.body ?? null,
    createdBy: row.createdById
      ? { id: row.createdById, displayName: createdByName ?? '' }
      : null,
    attachments: attachments.map(toAttachmentDto),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 附件行 → 契约 Attachment */
function toAttachmentDto(row: MinuteAttachmentRow): Attachment {
  return {
    id: row.id,
    name: row.name,
    contentType: row.contentType,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
  };
}
