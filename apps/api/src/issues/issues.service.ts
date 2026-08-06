import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, ilike, inArray } from 'drizzle-orm';
import {
  type AssigneesListResponse,
  type Issue,
  type IssueComment,
  type IssueCommentCreateResponse,
  type IssueCreateRequest,
  type IssueCreateResponse,
  type IssueGetResponse,
  type IssueLink,
  type IssueLinkRequest,
  type IssueLinkResponse,
  type IssueTransitionRequest,
  type IssueTransitionResponse,
  type IssueUpdateRequest,
  type IssueUpdateResponse,
  type IssuesListQuery,
  type IssuesListResponse,
  type ProjectViewerRole,
} from '@monitor/contracts';
import { can, type FunctionalRole, type IssueStatus } from '@monitor/shared';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/current-user.decorator';
import { DRIZZLE, type Database } from '../database/database.module';
import {
  blueprints,
  issueComments,
  issueLinks,
  issues,
  kbDocuments,
  meetingMinutes,
  projects,
  users,
  type IssueCommentRow,
  type IssueLinkRow,
  type IssueRow,
} from '../database/schema';
import { TenantContextService, type TenantContext } from '../database/tenant-context.service';
import { MembersService } from '../projects/members.service';
import { canTransition } from './issue-status';

/**
 * 问题清单（issue #15，数据边界 = 项目）。
 * 两层边界（与 projects/members 同构）：租户 RLS 兜底（跨租户 → 404 防探测）+
 * 应用层项目成员校验（同租户非成员 → 403）。项目级权限全部在 service 层按成员表
 * 解析（不建 guard——guard 在 TenantInterceptor 之前运行，查库会落在租户事务外）：
 * 提交=全员、评论=PM/KeyUser、修改管理=PM+、状态流转=内部专属（spec §2.4）。
 */
@Injectable()
export class IssuesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
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
    const role = await this.members.resolveProjectRole(projectId, ctx.userId);
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

  /** 提交人姓名（join users；删除 → null） */
  private async reporterNameOf(userId: string | null): Promise<string | null> {
    if (!userId) {
      return null;
    }
    const [u] = await this.db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return u?.displayName ?? null;
  }

  /**
   * 关联列表（issue #20）：多态目标标题按类型分三批批量查询（避免多态 join），内存组装。
   * 目标查不到（客户看内部关联的 kb 草稿/归档，被 RLS 挡）→ targetTitle null（前端显示「（不可见）」）。
   */
  private async loadLinks(issueId: string): Promise<IssueLink[]> {
    const rows = await this.db
      .select({
        id: issueLinks.id,
        issueId: issueLinks.issueId,
        targetType: issueLinks.targetType,
        targetId: issueLinks.targetId,
        createdById: issueLinks.createdById,
        createdAt: issueLinks.createdAt,
      })
      .from(issueLinks)
      .where(eq(issueLinks.issueId, issueId))
      .orderBy(issueLinks.createdAt);
    if (rows.length === 0) {
      return [];
    }

    const titles = new Map<string, string>(); // targetId → 展示标题
    const idsOf = (type: string) => rows.filter((r) => r.targetType === type).map((r) => r.targetId);
    const bpIds = idsOf('blueprint');
    if (bpIds.length > 0) {
      const bpRows = await this.db
        .select({ id: blueprints.id, name: blueprints.drawioName })
        .from(blueprints)
        .where(inArray(blueprints.id, bpIds));
      for (const b of bpRows) {
        titles.set(b.id, b.name);
      }
    }
    const minuteIds = idsOf('minute');
    if (minuteIds.length > 0) {
      const mRows = await this.db
        .select({ id: meetingMinutes.id, title: meetingMinutes.title })
        .from(meetingMinutes)
        .where(inArray(meetingMinutes.id, minuteIds));
      for (const m of mRows) {
        titles.set(m.id, m.title);
      }
    }
    const kbIds = idsOf('kb_document');
    if (kbIds.length > 0) {
      const kRows = await this.db
        .select({ id: kbDocuments.id, title: kbDocuments.title })
        .from(kbDocuments)
        .where(inArray(kbDocuments.id, kbIds));
      for (const k of kRows) {
        titles.set(k.id, k.title);
      }
    }

    const creatorIds = [...new Set(rows.map((r) => r.createdById).filter((x): x is string => x !== null))];
    const creatorNames = new Map<string, string>();
    if (creatorIds.length > 0) {
      const uRows = await this.db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, creatorIds));
      for (const u of uRows) {
        creatorNames.set(u.id, u.displayName);
      }
    }
    return rows.map((r) =>
      toLinkDto(r, titles.get(r.targetId) ?? null, r.createdById ? creatorNames.get(r.createdById) ?? null : null),
    );
  }

  /** 单条目标展示标题（blueprint → drawio 文件名；minute/kb → 标题；查不到 → null） */
  private async linkTargetTitle(targetType: string, targetId: string): Promise<string | null> {
    if (targetType === 'blueprint') {
      const [bp] = await this.db
        .select({ name: blueprints.drawioName })
        .from(blueprints)
        .where(eq(blueprints.id, targetId))
        .limit(1);
      return bp?.name ?? null;
    }
    if (targetType === 'minute') {
      const [m] = await this.db
        .select({ title: meetingMinutes.title })
        .from(meetingMinutes)
        .where(eq(meetingMinutes.id, targetId))
        .limit(1);
      return m?.title ?? null;
    }
    const [k] = await this.db
      .select({ title: kbDocuments.title })
      .from(kbDocuments)
      .where(eq(kbDocuments.id, targetId))
      .limit(1);
    return k?.title ?? null;
  }

  /** 问题行（RLS + 路径 projectId 双重匹配，跨项目/跨租户 → 404） */
  private async requireIssue(projectId: string, issueId: string): Promise<IssueRow> {
    const [row] = await this.db
      .select()
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.projectId, projectId)))
      .limit(1);
    if (!row) {
      throw new NotFoundException('问题不存在');
    }
    return row;
  }

  /** 角色级权限检查（viewerRole 为 null 时 fail closed） */
  private assertPermission(
    viewerRole: ProjectViewerRole,
    permission: 'issue:create' | 'issue:comment' | 'issue:manage' | 'issue:transition',
    message: string,
  ): void {
    if (!can(viewerRole as FunctionalRole, permission)) {
      throw new ForbiddenException(message);
    }
  }

  /** 列表（spec 41：分类/优先级/状态/类型/提交人筛选 + 标题搜索；viewerRole 供前端显隐入口） */
  async list(
    projectId: string,
    actor: AuthUser,
    query: IssuesListQuery,
  ): Promise<IssuesListResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);

    const filters = [eq(issues.projectId, projectId)];
    if (query.type) {
      filters.push(eq(issues.type, query.type));
    }
    if (query.category) {
      filters.push(eq(issues.category, query.category));
    }
    if (query.priority) {
      filters.push(eq(issues.priority, query.priority));
    }
    if (query.status) {
      filters.push(eq(issues.status, query.status));
    }
    if (query.reporterId) {
      filters.push(eq(issues.reporterId, query.reporterId));
    }
    const keyword = query.search?.trim();
    if (keyword) {
      filters.push(ilike(issues.title, `%${escapeLike(keyword)}%`));
    }

    // 两层边界已兜底：resolveViewerRole 保证客户用户是该项目 active 成员（403 非成员），
    // 数据库 RLS 再按租户过滤（跨租户查不到 → 空）。无需成员交集——列表按路径参数 projectId
    // 精确查询（区别于 projects 全局列表的成员交集）。
    const { id, projectId: pid, title, description, type, category, priority, status, reporterId, assigneeId, createdAt, updatedAt } = issues;
    const rows = await this.db
      .select({ id, projectId: pid, title, description, type, category, priority, status, reporterId, assigneeId, createdAt, updatedAt, reporterName: users.displayName })
      .from(issues)
      .leftJoin(users, eq(users.id, issues.reporterId))
      .where(and(...filters))
      .orderBy(issues.createdAt);
    return { issues: rows.map((r) => toIssueDto(r, r.reporterName)), viewerRole };
  }

  /** 提交问题（spec 36：所有项目角色 + 内部） */
  async create(
    projectId: string,
    actor: AuthUser,
    input: IssueCreateRequest,
  ): Promise<IssueCreateResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const project = await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'issue:create', '你没有权限提交问题');

    const [row] = await this.db
      .insert(issues)
      .values({
        tenantId: project.tenantId,
        projectId,
        title: input.title,
        description: input.description ?? null,
        type: input.type,
        category: input.category,
        priority: input.priority,
        reporterId: actor.sub,
      })
      .returning();
    if (!row) {
      throw new InternalServerErrorException('创建问题失败');
    }
    await this.audit.record(AUDIT_ACTIONS.ISSUE_CREATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'issue',
      resourceId: row.id,
      metadata: { projectId, title: row.title, category: row.category, priority: row.priority },
    });
    return { issue: toIssueDto(row, await this.reporterNameOf(row.reporterId)) };
  }

  /** 详情 + 评论 + 关联（评论/提交人带姓名 join users；关联多态标题批量组装） */
  async getById(
    projectId: string,
    issueId: string,
    actor: AuthUser,
  ): Promise<IssueGetResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const issue = await this.requireIssue(projectId, issueId);
    const viewerRole = await this.resolveViewerRole(issue.projectId, ctx);
    const reporterName = await this.reporterNameOf(issue.reporterId);

    const commentRows = await this.db
      .select({
        id: issueComments.id,
        issueId: issueComments.issueId,
        authorId: issueComments.authorId,
        content: issueComments.content,
        createdAt: issueComments.createdAt,
        authorName: users.displayName,
      })
      .from(issueComments)
      .leftJoin(users, eq(users.id, issueComments.authorId))
      .where(eq(issueComments.issueId, issue.id))
      .orderBy(issueComments.createdAt);
    const links = await this.loadLinks(issue.id);
    return {
      issue: toIssueDto(issue, reporterName),
      viewerRole,
      comments: commentRows.map((r) => toCommentDto(r, r.authorName)),
      links,
    };
  }

  /**
   * 修改/管理（spec 38：PM+，含指派内部负责人）。
   * 部分更新：undefined 不动、null 清空（description/assigneeId）、空对象=无操作。
   */
  async update(
    projectId: string,
    issueId: string,
    actor: AuthUser,
    input: IssueUpdateRequest,
  ): Promise<IssueUpdateResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'issue:manage', '仅项目经理或内部用户可修改问题');

    const issue = await this.requireIssue(projectId, issueId);
    if (
      input.title === undefined &&
      input.description === undefined &&
      input.type === undefined &&
      input.category === undefined &&
      input.priority === undefined &&
      input.assigneeId === undefined
    ) {
      return { issue: toIssueDto(issue) }; // 空对象 = 无操作（set({}) 会生成非法 SQL）
    }

    // 指派校验：仅内部/超管 active 用户可作为负责人（spec 37「指派内部负责人」）
    let assigneeId: string | null | undefined = input.assigneeId;
    if (assigneeId !== undefined && assigneeId !== null) {
      const [assignee] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, assigneeId), eq(users.isActive, true), inArray(users.role, ['super_admin', 'internal'])))
        .limit(1);
      if (!assignee) {
        throw new BadRequestException('指派人必须是内部用户');
      }
    }

    const [row] = await this.db
      .update(issues)
      .set({
        title: input.title,
        description: input.description,
        type: input.type,
        category: input.category,
        priority: input.priority,
        assigneeId,
        updatedAt: new Date(),
      })
      .where(and(eq(issues.id, issue.id), eq(issues.projectId, projectId)))
      .returning();
    if (!row) {
      throw new NotFoundException('问题不存在');
    }
    await this.audit.record(AUDIT_ACTIONS.ISSUE_UPDATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'issue',
      resourceId: row.id,
      metadata: {
        projectId,
        title: row.title,
        priority: row.priority,
        assigneeId: row.assigneeId,
      },
    });
    return { issue: toIssueDto(row, await this.reporterNameOf(row.reporterId)) };
  }

  /** 状态流转（spec 37：内部专属；严格线性前进，非法流转 400） */
  async transition(
    projectId: string,
    issueId: string,
    actor: AuthUser,
    input: IssueTransitionRequest,
  ): Promise<IssueTransitionResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'issue:transition', '仅内部用户可流转问题状态');

    const issue = await this.requireIssue(projectId, issueId);
    if (!canTransition(issue.status as IssueStatus, input.status)) {
      throw new BadRequestException(
        `非法状态流转：${issue.status} → ${input.status}（仅支持 新建→处理中→已解决→已关闭）`,
      );
    }
    const [row] = await this.db
      .update(issues)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(issues.id, issue.id))
      .returning();
    if (!row) {
      throw new NotFoundException('问题不存在');
    }
    await this.audit.record(AUDIT_ACTIONS.ISSUE_TRANSITION, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'issue',
      resourceId: row.id,
      metadata: { projectId, from: issue.status, to: row.status },
    });
    return { issue: toIssueDto(row, await this.reporterNameOf(row.reporterId)) };
  }

  /** 评论（spec 39/40：PM/KeyUser/内部；普通用户 403） */
  async addComment(
    projectId: string,
    issueId: string,
    actor: AuthUser,
    content: string,
  ): Promise<IssueCommentCreateResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'issue:comment', '普通用户没有评论权限');

    const issue = await this.requireIssue(projectId, issueId);
    const [row] = await this.db
      .insert(issueComments)
      .values({
        tenantId: issue.tenantId,
        issueId: issue.id,
        authorId: actor.sub,
        content,
      })
      .returning();
    if (!row) {
      throw new InternalServerErrorException('发表评论失败');
    }
    const [author] = await this.db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, actor.sub))
      .limit(1);
    await this.audit.record(AUDIT_ACTIONS.ISSUE_COMMENT, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'issue_comment',
      resourceId: row.id,
      metadata: { projectId, issueId: issue.id },
    });
    return { comment: toCommentDto(row, author?.displayName ?? null) };
  }

  /**
   * 关联（spec 42「关联蓝图/功能/文档」，issue #20；issue:manage = 内部 + PM）。
   * 目标校验：
   * - blueprint/minute：须属于同一项目（防跨项目关联）
   * - kb_document：全局文档，走 RLS 天然过滤——内部（internal_manage）任意状态；
   *   客户 PM（read_published）只见已发布，关联草稿/归档 → 查不到 → 400
   * unique(issueId, targetType, targetId) 防重复关联（DB 约束抛唯一冲突 → 500；此处先查防 400）
   */
  async addLink(
    projectId: string,
    issueId: string,
    actor: AuthUser,
    input: IssueLinkRequest,
  ): Promise<IssueLinkResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'issue:manage', '仅项目经理或内部用户可关联问题');
    const issue = await this.requireIssue(projectId, issueId);

    let targetOk = false;
    if (input.targetType === 'blueprint') {
      const [bp] = await this.db
        .select({ id: blueprints.id })
        .from(blueprints)
        .where(and(eq(blueprints.id, input.targetId), eq(blueprints.projectId, issue.projectId)))
        .limit(1);
      targetOk = !!bp;
    } else if (input.targetType === 'minute') {
      const [m] = await this.db
        .select({ id: meetingMinutes.id })
        .from(meetingMinutes)
        .where(and(eq(meetingMinutes.id, input.targetId), eq(meetingMinutes.projectId, issue.projectId)))
        .limit(1);
      targetOk = !!m;
    } else {
      const [k] = await this.db
        .select({ id: kbDocuments.id })
        .from(kbDocuments)
        .where(eq(kbDocuments.id, input.targetId))
        .limit(1);
      targetOk = !!k;
    }
    if (!targetOk) {
      throw new BadRequestException('关联对象不存在（蓝图/会议纪要须属于本项目，知识库文档须已发布）');
    }
    const [dup] = await this.db
      .select({ id: issueLinks.id })
      .from(issueLinks)
      .where(
        and(
          eq(issueLinks.issueId, issue.id),
          eq(issueLinks.targetType, input.targetType),
          eq(issueLinks.targetId, input.targetId),
        ),
      )
      .limit(1);
    if (dup) {
      throw new BadRequestException('已关联该对象');
    }

    const [row] = await this.db
      .insert(issueLinks)
      .values({
        tenantId: issue.tenantId,
        issueId: issue.id,
        targetType: input.targetType,
        targetId: input.targetId,
        createdById: actor.sub,
      })
      .returning();
    if (!row) {
      throw new InternalServerErrorException('关联失败');
    }
    await this.audit.record(AUDIT_ACTIONS.ISSUE_LINK, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'issue',
      resourceId: issue.id,
      metadata: { projectId, targetType: row.targetType, targetId: row.targetId },
    });
    const targetTitle = await this.linkTargetTitle(row.targetType, row.targetId);
    const [creator] = await this.db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, actor.sub))
      .limit(1);
    return { link: toLinkDto(row, targetTitle, creator?.displayName ?? null) };
  }

  /** 解除关联（issue:manage；同租户非本人可解——管理操作） */
  async removeLink(
    projectId: string,
    issueId: string,
    linkId: string,
    actor: AuthUser,
  ): Promise<void> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'issue:manage', '仅项目经理或内部用户可解除关联');
    const issue = await this.requireIssue(projectId, issueId);
    const [row] = await this.db
      .select()
      .from(issueLinks)
      .where(and(eq(issueLinks.id, linkId), eq(issueLinks.issueId, issue.id)))
      .limit(1);
    if (!row) {
      throw new NotFoundException('关联不存在');
    }
    await this.db.delete(issueLinks).where(eq(issueLinks.id, row.id));
    await this.audit.record(AUDIT_ACTIONS.ISSUE_UNLINK, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'issue',
      resourceId: issue.id,
      metadata: { projectId, targetType: row.targetType, targetId: row.targetId },
    });
  }

  /** 指派候选（内部/超管 active 用户；PM+ 可见） */
  async listAssignees(projectId: string, actor: AuthUser): Promise<AssigneesListResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'issue:manage', '仅项目经理或内部用户可查看指派候选');

    const rows = await this.db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(and(inArray(users.role, ['super_admin', 'internal']), eq(users.isActive, true)))
      .orderBy(users.displayName);
    return { assignees: rows };
  }
}

/** DB 行 → 契约 Issue：Date 必须 toISOString()（z.iso.datetime() 要求）；tenantId 不暴露 */
function toIssueDto(row: Omit<IssueRow, 'tenantId'>, reporterName: string | null = null): Issue {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description ?? null,
    type: row.type as Issue['type'],
    category: row.category as Issue['category'],
    priority: row.priority as Issue['priority'],
    status: row.status as Issue['status'],
    reporterId: row.reporterId,
    reporterName,
    assigneeId: row.assigneeId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 关联行 → 契约 IssueLink（targetTitle 由调用方组装） */
function toLinkDto(
  row: Pick<IssueLinkRow, 'id' | 'issueId' | 'targetType' | 'targetId' | 'createdById' | 'createdAt'>,
  targetTitle: string | null,
  creatorName: string | null,
): IssueLink {
  return {
    id: row.id,
    issueId: row.issueId,
    targetType: row.targetType as IssueLink['targetType'],
    targetId: row.targetId,
    targetTitle,
    createdBy: row.createdById ? { id: row.createdById, displayName: creatorName ?? '（已删除）' } : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 评论行 → 契约 IssueComment */
function toCommentDto(
  row: Pick<IssueCommentRow, 'id' | 'issueId' | 'authorId' | 'content' | 'createdAt'>,
  authorName: string | null,
): IssueComment {
  return {
    id: row.id,
    issueId: row.issueId,
    authorId: row.authorId,
    authorName,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

/** ILIKE 通配符转义（%/_/\），防用户输入当模式 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
