import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import { RAW_DB, type Database } from '../database/database.module';
import { users } from '../database/schema';
import { TenantContextService } from '../database/tenant-context.service';

/** 清理间隔默认值：1 小时（与 RAG worker 的定时模式一致；env 可覆盖） */
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 过期邀请清理（issue #41）：发出邀请后一直未点链接激活的客户账号不应永久存在——
 * isActive=false 且邀请已过期的待激活账号从系统消失（users 删除 → user_tenants /
 * project_members 外键级联自动清除；链接随即失效）。
 * - 定时：OnModuleInit + setInterval（INVITE_CLEANUP_INTERVAL_MS 可配，默认 1h）
 * - 启动即扫一次（进程重启后积压的过期邀请）
 * - 内部上下文事务（SET LOCAL app.is_internal=true 旁路 RLS）——清理跨全部租户
 */
@Injectable()
export class InviteCleanupWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InviteCleanupWorker.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(RAW_DB) private readonly base: Database,
    private readonly tenantContext: TenantContextService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    const interval =
      this.config.get<number>('INVITE_CLEANUP_INTERVAL_MS') ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.cleanupExpiredInvites().catch((err) =>
        this.logger.error(`清理过期邀请失败：${String(err)}`),
      );
    }, interval);
    // 启动即扫一次
    void this.cleanupExpiredInvites().catch((err) =>
      this.logger.error(`启动清理过期邀请失败：${String(err)}`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 删除所有邀请已过期的待激活账号，返回删除数（public：定时循环 + e2e 直接调用） */
  async cleanupExpiredInvites(): Promise<number> {
    return this.base.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_internal', 'true', true)`);
      return this.tenantContext.run(
        { tx, tenantId: null, isInternal: true, userId: 'system' },
        async () => {
          const expired = await tx
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(
              and(
                eq(users.isActive, false),
                isNotNull(users.inviteTokenHash),
                lte(users.inviteExpiresAt, new Date()),
              ),
            );
          for (const u of expired) {
            await tx.delete(users).where(eq(users.id, u.id));
            await this.audit.record(AUDIT_ACTIONS.USER_INVITE_EXPIRED, {
              actorUserId: null, // actor_user_id 是 uuid 列：系统动作无账号主体，置 NULL
              actorRole: 'system',
              resourceType: 'user',
              resourceId: u.id,
              metadata: { email: u.email, reason: 'invite_expired' },
            });
          }
          if (expired.length > 0) {
            this.logger.log(`清理过期邀请：删除 ${expired.length} 个待激活账号`);
          }
          return expired.length;
        },
      );
    });
  }
}
