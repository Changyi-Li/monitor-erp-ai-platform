import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type RegisterRequest,
  type RegisterResponse,
  type RefreshResponse,
  type User,
} from '@monitor/contracts';
import type { UserRole } from '@monitor/shared';
import { DRIZZLE, type Database } from '../database/database.module';
import { refreshTokens, users, type UserRow } from '../database/schema';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly password: PasswordService,
    private readonly token: TokenService,
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

    const passwordHash = await this.password.hash(input.password);
    const [user] = await this.db
      .insert(users)
      .values({ email, passwordHash, displayName })
      .returning();
    if (!user) {
      throw new InternalServerErrorException('创建用户失败');
    }
    return { user: toUserDto(user) };
  }

  async login(input: LoginRequest): Promise<LoginResponse> {
    const email = input.email.toLowerCase();
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // 统一文案，防用户枚举
    if (!user || !(await this.password.verify(input.password, user.passwordHash))) {
      throw new UnauthorizedException('邮箱或密码错误');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('账号已停用');
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

    return {
      user: toUserDto(user),
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresIn: access.expiresIn,
    };
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
}

/** DB 行 → 契约 User：Date 必须 toISOString()（z.iso.datetime() 要求），剔除 passwordHash */
function toUserDto(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role as User['role'],
    createdAt: row.createdAt.toISOString(),
  };
}
