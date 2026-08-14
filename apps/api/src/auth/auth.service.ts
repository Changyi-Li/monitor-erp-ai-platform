import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import {
  type CreateUserRequest,
  type CreateUserResponse,
  type InviteInfoResponse,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type RegisterRequest,
  type RegisterResponse,
  type RefreshResponse,
  type ResendInviteResponse,
  type ResetUserPasswordRequest,
  type ResetUserPasswordResponse,
  type SetPasswordRequest,
  type SetPasswordResponse,
  type UpdateUserRequest,
  type UpdateUserResponse,
  type User,
  type UsersListResponse,
} from '@monitor/contracts';
import type { AuthUser } from '../common/current-user.decorator';
import { isCustomerRole, type UserRole } from '@monitor/shared';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { DRIZZLE, type Database } from '../database/database.module';
import { refreshTokens, users, type UserRow } from '../database/schema';
import { InviteService } from './invite.service';
import { PasswordService } from './password.service';
import { sha256Hex } from './token-hash';
import { TokenService } from './token.service';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly password: PasswordService,
    private readonly token: TokenService,
    private readonly audit: AuditService,
    private readonly invite: InviteService,
  ) {}

  async register(input: RegisterRequest): Promise<RegisterResponse> {
    const email = input.email.toLowerCase();
    const displayName = input.displayName?.trim() ?? email.split('@')[0] ?? 'User';

    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictException('该邮箱已注册');
    }

    // 昵称唯一（#37 迭代）：display_name 部分唯一索引兜底，服务层先行查重给友好提示
    const dupName = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.displayName, displayName))
      .limit(1);
    if (dupName.length > 0) {
      throw new ConflictException('该昵称已被使用');
    }

    const passwordHash = await this.password.hash(input.password);
    const [user] = await this.db
      .insert(users)
      .values({ email, passwordHash, displayName, description: displayName })
      .returning();
    if (!user) {
      throw new InternalServerErrorException('创建用户失败');
    }
    return { user: toUserDto(user) };
  }

  async login(input: LoginRequest, ip?: string): Promise<LoginResponse> {
    const email = input.email.toLowerCase();
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // 统一文案，防用户枚举；失败同样记审计（含邮箱，供安全排查）
    if (!user || !(await this.password.verify(input.password, user.passwordHash))) {
      await this.audit.record(AUDIT_ACTIONS.LOGIN_FAILED, {
        actorRole: 'anonymous',
        resourceType: 'user',
        metadata: { email },
        ip,
      });
      throw new UnauthorizedException('邮箱或密码错误');
    }
    if (!user.isActive) {
      await this.audit.record(AUDIT_ACTIONS.LOGIN_FAILED, {
        actorRole: 'anonymous',
        resourceType: 'user',
        metadata: { email, reason: 'inactive' },
        ip,
      });
      throw new UnauthorizedException('账号未激活或已停用');
    }

    const access = this.token.signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role as UserRole,
    });
    const refresh = this.token.generateRefreshToken();
    await this.db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: refresh.tokenHash,
      expiresAt: refresh.expiresAt,
    });

    await this.audit.record(AUDIT_ACTIONS.LOGIN, {
      actorUserId: user.id,
      actorRole: user.role,
      resourceType: 'user',
      resourceId: user.id,
      metadata: { email },
      ip,
    });

    return {
      user: toUserDto(user),
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresIn: access.expiresIn,
    };
  }

  /** 邀请链接首次设密：一次性 token（sha256 落库），设密后立即失效 */
  async setPassword(input: SetPasswordRequest, ip?: string): Promise<SetPasswordResponse> {
    const user = await this.findValidInviteUser(sha256Hex(input.token));

    // 客户邀请（issue #50）：链接绑定邮箱——必须输入与创建时一致的邮箱才能激活
    if (user.inviteKind === 'customer') {
      if (!input.email || input.email.toLowerCase() !== user.email) {
        throw new BadRequestException('邮箱与邀请绑定不一致，请使用被邀请的邮箱');
      }
    }

    const passwordHash = await this.password.hash(input.password);
    await this.db
      .update(users)
      .set({
        passwordHash,
        inviteTokenHash: null,
        inviteExpiresAt: null,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    await this.audit.record(AUDIT_ACTIONS.SET_PASSWORD, {
      actorUserId: user.id,
      actorRole: user.role,
      resourceType: 'user',
      resourceId: user.id,
      ip,
    });

    return { ok: true };
  }

  /**
   * 邀请链接类型查询（issue #50）：公开端点，前端 /invite 页据此决定表单形状
   * （customer = 需邮箱校验，project = 现有设密表单）。校验规则与 set-password
   * 一致（无效 / 过期 / 已激活 → 400 统一文案）。
   */
  async inviteInfo(token: string): Promise<InviteInfoResponse> {
    const user = await this.findValidInviteUser(sha256Hex(token));
    return {
      kind: user.inviteKind === 'customer' ? 'customer' : 'project',
      email: user.email,
    };
  }

  /**
   * 按邀请 token 哈希查有效邀请用户（未过期、未激活）；无效 → 400 统一文案，
   * 不泄露具体状态（过期 / 已使用 / 不存在同文案）。set-password 与 invite-info 共用。
   */
  private async findValidInviteUser(tokenHash: string): Promise<UserRow> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.inviteTokenHash, tokenHash))
      .limit(1);
    if (
      !user ||
      !user.inviteExpiresAt ||
      user.inviteExpiresAt <= new Date() ||
      user.isActive
    ) {
      throw new BadRequestException('邀请链接无效或已过期');
    }
    return user;
  }

  /** 轮换式刷新：旧 token 标记 revoked + 插入新行（事务），旧 token 立即失效 */
  async refresh(refreshToken: string): Promise<RefreshResponse> {
    const tokenHash = this.token.hashRefreshToken(refreshToken);
    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);
    if (!row || row.revokedAt !== null || row.expiresAt <= new Date()) {
      throw new UnauthorizedException('会话已失效');
    }

    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('会话已失效');
    }

    const access = this.token.signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role as UserRole,
    });
    const next = this.token.generateRefreshToken();
    await this.db.transaction(async (tx) => {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.id, row.id));
      await tx.insert(refreshTokens).values({
        userId: user.id,
        tokenHash: next.tokenHash,
        expiresAt: next.expiresAt,
      });
    });

    return {
      accessToken: access.token,
      refreshToken: next.token,
      expiresIn: access.expiresIn,
    };
  }

  /** 登出：删除会话行（幂等，找不到也返回 204） */
  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.token.hashRefreshToken(refreshToken);
    await this.db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
  }

  /** me：从 JWT sub 重查库返回最新用户（角色可能变化） */
  async me(userId: string): Promise<MeResponse> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }
    return { user: toUserDto(user) };
  }

  /**
   * 超管创建内部用户（US-3，@Roles(super_admin) 守卫）：仿 register 查重/hash/insert，
   * 但显式写 role（super_admin/internal），并落审计 user.create。
   */
  async createUser(input: CreateUserRequest, actor: AuthUser): Promise<CreateUserResponse> {
    const email = input.email.toLowerCase();
    const displayName = input.displayName?.trim() ?? email.split('@')[0] ?? 'User';

    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictException('该邮箱已注册');
    }

    // 昵称唯一（#37 迭代）：display_name 部分唯一索引兜底，服务层先行查重给友好提示
    const dupName = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.displayName, displayName))
      .limit(1);
    if (dupName.length > 0) {
      throw new ConflictException('该昵称已被使用');
    }

    const passwordHash = await this.password.hash(input.password);
    const [user] = await this.db
      .insert(users)
      // 描述默认昵称（#37 迭代）：创建时 description = displayName，后续可编辑为不同内容
      .values({ email, passwordHash, displayName, role: input.role, description: displayName })
      .returning();
    if (!user) {
      throw new InternalServerErrorException('创建用户失败');
    }

    await this.audit.record(AUDIT_ACTIONS.USER_CREATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'user',
      resourceId: user.id,
      metadata: { email, role: input.role },
    });
    return {
      user: {
        ...toUserDto(user),
        isActive: true,
        inviteKind: user.inviteKind as 'customer' | null,
      },
    };
  }

  /** 用户管理列表（@Roles(super_admin, internal) 守卫，全量平台账号） */
  async listUsers(): Promise<UsersListResponse> {
    const rows = await this.db
      .select()
      .from(users)
      .orderBy(users.createdAt);
    return {
      users: rows.map((row) => ({
        ...toUserDto(row),
        isActive: row.isActive,
        inviteKind: row.inviteKind as 'customer' | null,
      })),
    };
  }

  /**
   * 更新用户资料（#37/#38 + grilling 昵称编辑）：description + role + displayName。
   * 权限（字段级，按 actor 判定；入口已开放到所有登录角色）：
   * - 目标鉴权：改自己 = 任何登录角色；改别人 = 仅超管（同 reset-password 模式）
   * - displayName（昵称）：本人或超管（目标鉴权已覆盖）
   * - description：仅超管（自始至终超管专属，不随昵称编辑放开）
   * - role：仅超管 + 不能改自己（防最后一名超管把自己降级锁死平台）+ 同域互转
   *   （T3：客户三档之间可互调——超管可把客户用户调整为 customer_pm；内部两值互改；
   *   customer ↔ internal 禁止互转 400，平台域边界不可跨越）
   * 先查后更，未命中 404（防探测语义同客户）。
   */
  async updateUser(
    userId: string,
    input: UpdateUserRequest,
    actor: AuthUser,
  ): Promise<UpdateUserResponse> {
    if (actor.sub !== userId && actor.role !== 'super_admin') {
      throw new ForbiddenException('没有权限执行该操作');
    }

    const [existing] = await this.db
      .select({ id: users.id, role: users.role, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!existing) {
      throw new NotFoundException('用户不存在');
    }

    if (input.role !== undefined) {
      if (actor.role !== 'super_admin') {
        throw new ForbiddenException('没有权限执行该操作');
      }
      if (actor.sub === userId) {
        throw new ConflictException('不能修改自己的角色');
      }
      // T3：同域互转——目标角色与原角色同在客户域或同在内部域才允许；
      // 客户 PM 档（customer_pm）不再锁定，超管可把客户用户在客户三档间互调
      const sameDomain =
        isCustomerRole(existing.role as UserRole) === isCustomerRole(input.role);
      if (!sameDomain) {
        throw new BadRequestException('客户角色与内部角色不可互转');
      }
    }

    if (input.description !== undefined && actor.role !== 'super_admin') {
      throw new ForbiddenException('没有权限执行该操作');
    }

    // 昵称唯一（#37 迭代）：display_name 部分唯一索引兜底，服务层先行查重给友好提示
    if (
      input.displayName !== undefined &&
      input.displayName !== existing.displayName
    ) {
      const dupName = await this.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.displayName, input.displayName), ne(users.id, userId)))
        .limit(1);
      if (dupName.length > 0) {
        throw new ConflictException('该昵称已被使用');
      }
    }

    const [updated] = await this.db
      .update(users)
      .set({
        // drizzle 对 undefined 字段不生成 SET 子句 → 天然 PATCH 部分语义
        ...(input.description !== undefined && { description: input.description }),
        ...(input.role !== undefined && { role: input.role }),
        ...(input.displayName !== undefined && { displayName: input.displayName }),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();
    if (!updated) {
      throw new InternalServerErrorException('更新用户失败');
    }

    await this.audit.record(AUDIT_ACTIONS.USER_UPDATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'user',
      resourceId: userId,
      metadata: {
        ...(input.role !== undefined && { role: input.role }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.displayName !== undefined && { displayName: input.displayName }),
      },
    });
    return {
      user: {
        ...toUserDto(updated),
        isActive: updated.isActive,
        inviteKind: updated.inviteKind as 'customer' | null,
      },
    };
  }

  /**
   * 重发客户邀请（grilling：未激活客户链接再发放，仅超管）：
   * 重新生成一次性 token——旧链接立即失效，有效期刷新为 7 天（InviteService 语义）。
   * 安全边界：已激活用户 → 409（激活后无邀请可言）；项目成员邀请账号（inviteKind=null）→ 409
   * （该类邀请在项目成员页面重发，避免两处入口语义混乱）。
   */
  async resendInviteUser(userId: string, actor: AuthUser): Promise<ResendInviteResponse> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    if (user.isActive) {
      throw new ConflictException('该用户已激活，无需重发邀请链接');
    }
    if (user.inviteKind !== 'customer') {
      throw new ConflictException('该账号不是客户邀请账号（项目成员邀请请在项目成员页面重发）');
    }

    const { token, expiresAt } = await this.invite.resendInviteWithExpiry(this.db, userId);
    await this.audit.record(AUDIT_ACTIONS.USER_INVITE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'user',
      resourceId: userId,
      metadata: { email: user.email, resent: true },
    });
    return { inviteUrl: this.invite.buildInviteUrl(token), expiresAt: expiresAt.toISOString() };
  }

  /**
   * 重置用户密码（#39）：改自己 = 任何登录角色；改别人 = 仅超管（用户拍板）。
   * 先查后更，未命中 404（防探测语义同 updateUser）。
   */
  async resetUserPassword(
    userId: string,
    input: ResetUserPasswordRequest,
    actor: AuthUser,
  ): Promise<ResetUserPasswordResponse> {
    const [existing] = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!existing) {
      throw new NotFoundException('用户不存在');
    }

    if (actor.sub !== userId && actor.role !== 'super_admin') {
      throw new ForbiddenException('没有权限执行该操作');
    }

    const passwordHash = await this.password.hash(input.password);
    await this.db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, userId));

    await this.audit.record(AUDIT_ACTIONS.USER_RESET_PASSWORD, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'user',
      resourceId: userId,
      metadata: { email: existing.email },
    });
    return { ok: true };
  }
}

/** DB 行 → 契约 User：Date 必须 toISOString()（z.iso.datetime() 要求），剔除 passwordHash */
function toUserDto(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    description: row.description ?? null,
    role: row.role as User['role'],
    createdAt: row.createdAt.toISOString(),
  };
}
