import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import {
  type Member,
  type MemberInviteRequest,
  type MemberInviteResponse,
  type MembersListResponse,
  type MemberUpdateRequest,
  type PendingInvite,
} from '@monitor/contracts';
import type { ProjectRole, UserRole } from '@monitor/shared';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { PasswordService } from '../auth/password.service';
import { sha256Hex } from '../auth/token-hash';
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

/** 邀请 token 有效期（一次性；重发刷新） */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 项目成员管理（数据边界 = 项目，spec §2.1/§2.3）。
 * 项目级权限全部在 service 层按成员表解析（不建 guard——guard 在 TenantInterceptor
 * 之前运行，查库会落在租户事务外）：内部全权；客户用户须是该项目 active PM。
 * 403 vs 404 语义（与项目详情一致）：跨租户（RLS 兜底查不到）→ 404 防探测；
 * 同租户可见但无管理权限 → 403。
 */
@Injectable()
export class MembersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly tenantContext: TenantContextService,
    private readonly password: PasswordService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /** 用户在某项目的 active 角色；非成员或已停用 → null */
  async resolveProjectRole(
    projectId: string,
    userId: string,
  ): Promise<ProjectRole | null> {
    const [row] = await this.db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
          eq(projectMembers.isActive, true),
        ),
      )
      .limit(1);
    return (row?.role as ProjectRole) ?? null;
  }

  /**
   * 成员管理准入：内部 → 放行；客户 → 须为该项目 active PM。
   * 项目行查询走 RLS：客户连接查不到他租户的项目（跨租户 → 404），
   * 查得到但非 PM → 403。
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
    const role = await this.resolveProjectRole(projectId, actor.sub);
    if (role !== 'project_manager') {
      throw new ForbiddenException('仅项目经理可管理该项目成员');
    }
  }

  async list(projectId: string, actor: AuthUser): Promise<MembersListResponse> {
    await this.requireManageAccess(projectId, actor);
    const rows = await this.db
      .select({
        id: projectMembers.id,
        projectId: projectMembers.projectId,
        userId: projectMembers.userId,
        role: projectMembers.role,
        isActive: projectMembers.isActive,
        createdAt: projectMembers.createdAt,
        email: users.email,
        displayName: users.displayName,
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
          role: r.role as ProjectRole,
          invitedAt: r.createdAt.toISOString(),
          // 持有 token 必有过期时间（invite()/重发均设置）；异常数据（手工/遗留）防御回退为已过期
          expiresAt: r.inviteExpiresAt?.toISOString() ?? new Date(0).toISOString(),
        });
      } else {
        members.push(toMemberDto(r, r.email, r.displayName));
      }
    }
    return { members, pendingInvites };
  }

  /**
   * 邀请成员（唯一建号入口）：
   * - 内部可授任一项目角色；客户 PM 只能 key_user/regular_user（不可升级角色）
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

    if (!ctx.isInternal && body.role === 'project_manager') {
      throw new ForbiddenException('项目经理角色只能由内部用户授予');
    }

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

    // 新用户：占位密码（不可登录）+ 邀请 token + 租户归属 + 成员行
    const token = randomBytes(32).toString('base64url');
    const placeholderHash = await this.password.hash(randomBytes(24).toString('base64url'));
    const [user] = await this.db
      .insert(users)
      .values({
        email,
        passwordHash: placeholderHash,
        displayName: body.displayName?.trim() ?? email.split('@')[0] ?? 'User',
        role: 'customer',
        isActive: false,
        inviteTokenHash: sha256Hex(token),
        inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      .returning();
    if (!user) {
      throw new InternalServerErrorException('创建用户失败');
    }
    await this.db
      .insert(userTenants)
      .values({ userId: user.id, customerId: project.tenantId })
      .onConflictDoNothing();
    const [member] = await this.db
      .insert(projectMembers)
      .values({ projectId, userId: user.id, role: body.role, invitedBy: actor.sub })
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
      member: toMemberDto(member, email, user.displayName),
      inviteUrl: this.buildInviteUrl(token),
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
    if (existingUser.role !== 'customer') {
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
      // 待激活成员：重发邀请链接（角色不变）
      const token = randomBytes(32).toString('base64url');
      await this.db
        .update(users)
        .set({
          inviteTokenHash: sha256Hex(token),
          inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
          updatedAt: new Date(),
        })
        .where(eq(users.id, existingUser.id));
      await this.audit.record(AUDIT_ACTIONS.MEMBER_ADD, {
        actorUserId: actor.sub,
        actorRole: actor.role,
        resourceType: 'project_member',
        resourceId: existingMember.id,
        metadata: { projectId, userId: existingUser.id, invited: true, resent: true },
      });
      return {
        member: toMemberDto(existingMember, existingUser.email, existingUser.displayName),
        inviteUrl: this.buildInviteUrl(token),
      };
    }

    // 同租户已激活账号：直接加成员，无需设密（无租户归属的防御性补齐）
    if (!tenant) {
      await this.db
        .insert(userTenants)
        .values({ userId: existingUser.id, customerId: projectTenantId })
        .onConflictDoNothing();
    }
    const [member] = await this.db
      .insert(projectMembers)
      .values({ projectId, userId: existingUser.id, role: body.role, invitedBy: actor.sub })
      .returning();
    if (!member) {
      throw new InternalServerErrorException('创建成员失败');
    }
    await this.audit.record(AUDIT_ACTIONS.MEMBER_ADD, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'project_member',
      resourceId: member.id,
      metadata: { projectId, userId: existingUser.id, role: body.role, invited: false },
    });
    return {
      member: toMemberDto(member, existingUser.email, existingUser.displayName),
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
    const [member] = await this.db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
        ),
      )
      .limit(1);
    if (!member) {
      throw new NotFoundException('该用户不是本项目成员');
    }

    const ctx = this.tenantContext.current;
    // 客户 PM 只能停用 key_user/regular_user（不能动 PM/自己）；内部全权
    if (
      !ctx?.isInternal &&
      member.role !== 'key_user' &&
      member.role !== 'regular_user'
    ) {
      throw new ForbiddenException('项目经理只能停用 Key User 或普通用户成员');
    }

    await this.db
      .update(projectMembers)
      .set({ isActive: body.isActive, updatedAt: new Date() })
      .where(eq(projectMembers.id, member.id));
    await this.audit.record(
      body.isActive ? AUDIT_ACTIONS.MEMBER_ACTIVATE : AUDIT_ACTIONS.MEMBER_DEACTIVATE,
      {
        actorUserId: actor.sub,
        actorRole: actor.role,
        resourceType: 'project_member',
        resourceId: member.id,
        metadata: { projectId, userId },
      },
    );
  }

  private buildInviteUrl(token: string): string {
    const webUrl = this.config.get<string>('WEB_URL') ?? 'http://localhost:3000';
    return `${webUrl}/invite?token=${token}`;
  }
}

/** 成员行 + 联查用户信息 → 契约 Member：Date toISOString()（z.iso.datetime() 要求） */
function toMemberDto(
  row: Pick<ProjectMemberRow, 'id' | 'projectId' | 'userId' | 'role' | 'isActive' | 'createdAt'>,
  email: string,
  displayName: string,
): Member {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    role: row.role as ProjectRole,
    isActive: row.isActive,
    email,
    displayName,
    createdAt: row.createdAt.toISOString(),
  };
}
