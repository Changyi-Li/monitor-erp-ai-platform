import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  type Member,
  type MemberInviteRequest,
  type MemberInviteResponse,
  type MembersListResponse,
  type MemberUpdateRequest,
  type PendingInvite,
} from '@monitor/contracts';
import { can, isCustomerRole, type CustomerRole, type UserRole } from '@monitor/shared';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { InviteService } from '../auth/invite.service';
import type { AuthUser } from '../common/current-user.decorator';
import { DRIZZLE, type Database } from '../database/database.module';
import {
  projectMembers,
  projects,
  users,
  userTenants,
  type ProjectMemberRow,
} from '../database/schema';
import { TenantContextService } from '../database/tenant-context.service';

/**
 * 项目成员管理（数据边界 = 项目，spec §2.1/§2.3）。
 * 项目级权限全部在 service 层解析（不建 guard——guard 在 TenantInterceptor
 * 之前运行，查库会落在租户事务外）：内部全权；客户管理资格 = 平台角色
 * customer_pm（T2，权限判定完全基于平台角色；project_members.role 已退役，
 * 成员角色 = users.role）。
 * 403 vs 404 语义（与项目详情一致）：跨租户（RLS 兜底查不到）→ 404 防探测；
 * 同租户可见但无管理权限 → 403。
 */
@Injectable()
export class MembersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly tenantContext: TenantContextService,
    private readonly inviteService: InviteService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 用户在某项目的 viewerRole（平台角色；T2：project_members.role 退役后
   * 成员角色 = users.role）；非 active 成员 → null。
   */
  async resolveViewerRole(
    projectId: string,
    userId: string,
  ): Promise<CustomerRole | null> {
    const [row] = await this.db
      .select({ role: users.role })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
          eq(projectMembers.isActive, true),
        ),
      )
      .limit(1);
    return (row?.role as CustomerRole) ?? null;
  }

  /**
   * 成员管理准入（T2 语义）：内部 → 放行；客户 → 平台角色须为 customer_pm
   * 且是该项目的 active 成员（"在自己项目内管理成员"）。
   * 顺序与项目详情一致：先查项目（跨租户/不存在 → 404 防探测），
   * 再查角色与成员资格（同租户可见但无管理资格 → 403）。
   */
  private async requireManageAccess(projectId: string, actor: AuthUser): Promise<void> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    if (ctx.isInternal) {
      return;
    }
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) {
      throw new NotFoundException('项目不存在');
    }
    // 矩阵单一事实源（PERMISSION_MATRIX['member:manage']）；客户分支下
    // 等价于 actor.role === 'customer_pm'
    if (!can(actor.role, 'member:manage')) {
      throw new ForbiddenException('仅客户项目经理可管理该项目成员');
    }
    const [member] = await this.db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, actor.sub),
          eq(projectMembers.isActive, true),
        ),
      )
      .limit(1);
    if (!member) {
      throw new ForbiddenException('你不在该项目成员中');
    }
  }

  async list(projectId: string, actor: AuthUser): Promise<MembersListResponse> {
    await this.requireManageAccess(projectId, actor);
    const rows = await this.db
      .select({
        id: projectMembers.id,
        projectId: projectMembers.projectId,
        userId: projectMembers.userId,
        isActive: projectMembers.isActive,
        createdAt: projectMembers.createdAt,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        userIsActive: users.isActive,
        inviteTokenHash: users.inviteTokenHash,
        inviteExpiresAt: users.inviteExpiresAt,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, projectId))
      .orderBy(projectMembers.createdAt);
    const members: Member[] = [];
    const pendingInvites: PendingInvite[] = [];
    for (const r of rows) {
      // 分组判据 = 用户账号激活状态（issue #42）：待激活 = 账号未激活且持有邀请 token；
      // 成员停用（project_members.is_active=false）仍是真实成员，留在 members 区
      if (!r.userIsActive && r.inviteTokenHash) {
        pendingInvites.push({
          userId: r.userId,
          email: r.email,
          displayName: r.displayName,
          role: r.role as CustomerRole,
          invitedAt: r.createdAt.toISOString(),
          // 持有 token 必有过期时间（invite()/重发均设置）；异常数据（手工/遗留）防御回退为已过期
          expiresAt: r.inviteExpiresAt?.toISOString() ?? new Date(0).toISOString(),
        });
      } else {
        members.push(toMemberDto(r, r.email, r.displayName, r.role));
      }
    }
    return { members, pendingInvites };
  }

  /**
   * 邀请成员（唯一建号入口）：
   * - role = 新账号平台角色档位（customer_key_user/customer_user，契约层限定；
   *   customer_pm 档只能由建客户/超管产生，T3）——仅用于新账号创建
   * - 新邮箱 → 建 invited 账号 + user_tenants + 成员行，返回邀请链接
   * - 同租户已有账号（未激活）→ 重发邀请链接；已激活 → 直接加成员（inviteUrl=null）
   * - 他租户用户 → 409；内部账号邮箱 → 400
   */
  async invite(
    projectId: string,
    actor: AuthUser,
    body: MemberInviteRequest,
  ): Promise<MemberInviteResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireManageAccess(projectId, actor);

    // 项目的租户（客户成员的新账号归属；客户 actor 的 RLS 已保证项目在租户内）
    const [project] = await this.db
      .select({ id: projects.id, tenantId: projects.tenantId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) {
      throw new NotFoundException('项目不存在');
    }

    const email = body.email.toLowerCase();
    const [existingUser] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existingUser) {
      return this.addExistingUser(projectId, project.tenantId, actor, body, existingUser);
    }

    // 新用户：占位密码（不可登录）+ 邀请 token + 租户归属 + 成员行。
    // 账号平台角色 = body.role 档位（T2：邀请时可选 customer_key_user/customer_user）
    const { token, user } = await this.inviteService.createInvitedUser(this.db, {
      email,
      displayName: body.displayName?.trim() ?? email.split('@')[0] ?? 'User',
      inviteKind: null,
      role: body.role,
    });
    await this.db
      .insert(userTenants)
      .values({ userId: user.id, customerId: project.tenantId })
      .onConflictDoNothing();
    const [member] = await this.db
      .insert(projectMembers)
      .values({ projectId, userId: user.id, invitedBy: actor.sub })
      .returning();
    if (!member) {
      throw new InternalServerErrorException('创建成员失败');
    }

    await this.audit.record(AUDIT_ACTIONS.MEMBER_ADD, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'project_member',
      resourceId: member.id,
      metadata: { projectId, userId: user.id, role: body.role, invited: true },
    });

    return {
      member: toMemberDto(member, email, user.displayName, user.role),
      inviteUrl: this.inviteService.buildInviteUrl(token),
    };
  }

  /**
   * 已存在用户：校验租户归属与成员关系后，重发邀请或直接加成员。
   * 租户基准 = 项目租户（客户 PM 的项目 = 自己租户；内部用户邀请他租户已有用户
   * 时 ctx.tenantId 为 null，必须以项目租户判断是否跨租户）。
   */
  private async addExistingUser(
    projectId: string,
    projectTenantId: string,
    actor: AuthUser,
    body: MemberInviteRequest,
    existingUser: typeof users.$inferSelect,
  ): Promise<MemberInviteResponse> {
    if (!isCustomerRole(existingUser.role as UserRole)) {
      throw new BadRequestException('不能邀请内部账号加入项目');
    }
    const [tenant] = await this.db
      .select({ customerId: userTenants.customerId })
      .from(userTenants)
      .where(
        and(
          eq(userTenants.userId, existingUser.id),
          eq(userTenants.customerId, projectTenantId),
        ),
      )
      .limit(1);
    // 用户已有其他租户归属 → 409（跨租户成员关系本期不支持，ADR-0001）
    if (!tenant) {
      const [anyTenant] = await this.db
        .select({ customerId: userTenants.customerId })
        .from(userTenants)
        .where(eq(userTenants.userId, existingUser.id))
        .limit(1);
      if (anyTenant) {
        throw new ConflictException('该用户已属于其他客户');
      }
    }

    const [existingMember] = await this.db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, existingUser.id),
        ),
      )
      .limit(1);

    if (existingMember) {
      if (existingUser.isActive) {
        throw new ConflictException('该用户已是本项目成员');
      }
      // 待激活成员：重发邀请链接（T2：project_members.role 已退役，重发只换链接，
      // 不触碰账号平台角色——无 project_manager 升级向量可绕过）
      const token = await this.inviteService.resendInvite(this.db, existingUser.id);
      await this.audit.record(AUDIT_ACTIONS.MEMBER_ADD, {
        actorUserId: actor.sub,
        actorRole: actor.role,
        resourceType: 'project_member',
        resourceId: existingMember.id,
        metadata: { projectId, userId: existingUser.id, invited: true, resent: true },
      });
      return {
        member: toMemberDto(existingMember, existingUser.email, existingUser.displayName, existingUser.role),
        inviteUrl: this.inviteService.buildInviteUrl(token),
      };
    }

    // 同租户已激活账号：直接加成员，无需设密（无租户归属的防御性补齐）。
    // T2：成员行不再存角色，账号平台角色保持不动（body.role 仅用于新账号创建）
    if (!tenant) {
      await this.db
        .insert(userTenants)
        .values({ userId: existingUser.id, customerId: projectTenantId })
        .onConflictDoNothing();
    }
    const [member] = await this.db
      .insert(projectMembers)
      .values({ projectId, userId: existingUser.id, invitedBy: actor.sub })
      .returning();
    if (!member) {
      throw new InternalServerErrorException('创建成员失败');
    }
    await this.audit.record(AUDIT_ACTIONS.MEMBER_ADD, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'project_member',
      resourceId: member.id,
      metadata: { projectId, userId: existingUser.id, invited: false },
    });
    return {
      member: toMemberDto(member, existingUser.email, existingUser.displayName, existingUser.role),
      inviteUrl: null,
    };
  }

  /** 停用/启用成员：只翻 is_active（用户可能在其他项目 active；旧 token ≤15m 自愈） */
  async update(
    projectId: string,
    userId: string,
    actor: AuthUser,
    body: MemberUpdateRequest,
  ): Promise<void> {
    await this.requireManageAccess(projectId, actor);
    const [row] = await this.db
      .select({
        id: projectMembers.id,
        role: users.role,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new NotFoundException('该用户不是本项目成员');
    }

    const ctx = this.tenantContext.current;
    // 客户 PM 只能停用 customer_key_user/customer_user 成员（不能动 customer_pm/自己）；内部全权
    if (!ctx?.isInternal && row.role === 'customer_pm') {
      throw new ForbiddenException('客户项目经理不能停用其他项目经理或本人成员关系');
    }

    await this.db
      .update(projectMembers)
      .set({ isActive: body.isActive, updatedAt: new Date() })
      .where(eq(projectMembers.id, row.id));
    await this.audit.record(
      body.isActive ? AUDIT_ACTIONS.MEMBER_ACTIVATE : AUDIT_ACTIONS.MEMBER_DEACTIVATE,
      {
        actorUserId: actor.sub,
        actorRole: actor.role,
        resourceType: 'project_member',
        resourceId: row.id,
        metadata: { projectId, userId },
      },
    );
  }

  /**
   * 取消邀请（issue #43）：仅待激活邀请（账号未激活且持有邀请 token）可取消——
   * 直接删除该客户账号（user_tenants/project_members 为 DB 级联删除），
   * 旧链接立即失效。已激活成员走停用操作（409）。
   * 权限与成员管理一致：内部全权；客户 PM 可取消自己项目内的任何待激活邀请
   * （T2：无 project_manager 档，邀请均为 key_user/customer_user 档）。
   */
  async cancelInvite(projectId: string, userId: string, actor: AuthUser): Promise<void> {
    await this.requireManageAccess(projectId, actor);
    const [row] = await this.db
      .select({
        id: projectMembers.id,
        userIsActive: users.isActive,
        inviteTokenHash: users.inviteTokenHash,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new NotFoundException('该用户不是本项目成员');
    }
    if (row.userIsActive || !row.inviteTokenHash) {
      throw new ConflictException('该用户已激活，不能取消邀请（如需移除请停用成员）');
    }
    // 删账号行：user_tenants/project_members 级联清除，所有项目里的待激活关系一并失效
    await this.db.delete(users).where(eq(users.id, userId));
    await this.audit.record(AUDIT_ACTIONS.MEMBER_INVITE_CANCEL, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'project_member',
      resourceId: row.id,
      metadata: { projectId, userId },
    });
  }

}

/** 成员行 + 联查用户信息 → 契约 Member：Date toISOString()（z.iso.datetime() 要求）；
 * role = 账号平台角色（T2：project_members.role 退役） */
function toMemberDto(
  row: Pick<ProjectMemberRow, 'id' | 'projectId' | 'userId' | 'isActive' | 'createdAt'>,
  email: string,
  displayName: string,
  role: string,
): Member {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    role: role as CustomerRole,
    isActive: row.isActive,
    email,
    displayName,
    createdAt: row.createdAt.toISOString(),
  };
}
