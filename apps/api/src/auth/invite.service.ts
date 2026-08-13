import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Database } from '../database/database.module';
import { users, type UserRow } from '../database/schema';
import { PasswordService } from './password.service';
import { sha256Hex } from './token-hash';

/** 邀请 token 有效期（7 天；项目成员邀请与客户邀请共用，重发刷新） */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 待激活账号 + 邀请链接（项目成员邀请 / 客户邀请共用，code review #50-52 抽取）：
 * - createInvitedUser：随机占位密码（不可登录）+ 一次性 token（库中仅存哈希）+ 过期时间
 * - buildInviteUrl：前端 /invite?token=… 链接
 * 两处调用方（MembersService.invite / CustomersService.create）不再各自维护
 * 占位账号插入块与 TTL/链接常量。
 */
@Injectable()
export class InviteService {
  constructor(
    private readonly password: PasswordService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 建待激活占位账号（随机密码哈希，登录必失败），返回 { token, user }。
   * token 仅以 sha256 哈希落库，响应外不透明存储。db 接受事务或直连
   * （调用方在事务内则随事务回滚）。
   */
  async createInvitedUser(
    db: Pick<Database, 'insert'>,
    input: { email: string; displayName: string; inviteKind: 'customer' | null },
  ): Promise<{ token: string; user: UserRow }> {
    const token = randomBytes(32).toString('base64url');
    const placeholderHash = await this.password.hash(randomBytes(24).toString('base64url'));
    const [user] = await db
      .insert(users)
      .values({
        email: input.email,
        passwordHash: placeholderHash,
        displayName: input.displayName,
        role: 'customer',
        isActive: false,
        inviteTokenHash: sha256Hex(token),
        inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
        inviteKind: input.inviteKind,
      })
      .returning();
    if (!user) {
      throw new InternalServerErrorException('创建用户失败');
    }
    return { token, user };
  }

  /**
   * 重发邀请（issue #43）：刷新 token 哈希与过期时间，密码/角色不动。
   * 返回 { token, expiresAt }——grilling 链接再发放需要向前端展示新过期时间；
   * resendInvite 为兼容旧调用方（仅要 token）保留薄封装。
   */
  async resendInviteWithExpiry(
    db: Pick<Database, 'update'>,
    userId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await db
      .update(users)
      .set({
        inviteTokenHash: sha256Hex(token),
        inviteExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
    return { token, expiresAt };
  }

  /** 重发邀请（issue #43 旧签名）：仅返回新 token（members.service 兼容用） */
  async resendInvite(db: Pick<Database, 'update'>, userId: string): Promise<string> {
    const { token } = await this.resendInviteWithExpiry(db, userId);
    return token;
  }

  buildInviteUrl(token: string): string {
    const webUrl = this.config.get<string>('WEB_URL') ?? 'http://localhost:3000';
    return `${webUrl}/invite?token=${token}`;
  }
}
