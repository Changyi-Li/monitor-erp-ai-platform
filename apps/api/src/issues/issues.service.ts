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
  issueComments,
  issues,
  projects,
  users,
  type IssueCommentRow,
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

  /** 列表（spec 41：分类/优先级/状态/类型筛选 + 标题搜索；viewerRole 供前端显隐入口） */
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
    const keyword = query.search?.trim();
    if (keyword) {
      filters.push(ilike(issues.title, `%${escapeLike(keyword)}%`));
    }

    // 两层边界已兜底：resolveViewerRole 保证客户用户是该项目 active 成员（403 非成员），
    // 数据库 RLS 再按租户过滤（跨租户查不到 → 空）。无需成员交集——列表按路径参数 projectId
    // 精确查询（区别于 projects 全局列表的成员交集）。
    const rows = await this.db
      .select()
      .from(issues)
      .where(and(...filters))
      .orderBy(issues.createdAt);
    return { issues: rows.map(toIssueDto), viewerRole };
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
    return { issue: toIssueDto(row) };
  }

  /** 详情 + 评论（评论带作者名，join users） */
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
    return {
      issue: toIssueDto(issue),
      viewerRole,
      comments: commentRows.map((r) => toCommentDto(r, r.authorName)),
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
    return { issue: toIssueDto(row) };
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
    return { issue: toIssueDto(row) };
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

/** DB 行 → 契约 Issue：Date 必须 toISOString()（z.iso.datetime() 要求） */
function toIssueDto(row: IssueRow): Issue {
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
    assigneeId: row.assigneeId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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
