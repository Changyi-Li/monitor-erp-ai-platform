import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE, type Database } from '../database/database.module';
import { auditLogs } from '../database/schema';
import { TenantContextService } from '../database/tenant-context.service';

/** 审计动作常量（保持字符串形态落库，便于查询与统计） */
export const AUDIT_ACTIONS = {
  LOGIN: 'auth.login',
  LOGIN_FAILED: 'auth.login_failed',
  SET_PASSWORD: 'auth.set_password',
  USER_INVITE: 'user.invite',
  CUSTOMER_CREATE: 'customer.create',
  CUSTOMER_UPDATE: 'customer.update',
  PROJECT_CREATE: 'project.create',
  PROJECT_READ: 'project.read',
  MEMBER_ADD: 'member.add',
  MEMBER_DEACTIVATE: 'member.deactivate',
  MEMBER_ACTIVATE: 'member.activate',
  ISSUE_CREATE: 'issue.create',
  ISSUE_UPDATE: 'issue.update',
  ISSUE_TRANSITION: 'issue.transition',
  ISSUE_COMMENT: 'issue.comment',
  ISSUE_LINK: 'issue.link',
  ISSUE_UNLINK: 'issue.unlink',
  BLUEPRINT_CREATE: 'blueprint.create',
  BLUEPRINT_UPDATE: 'blueprint.update',
  BLUEPRINT_PUBLISH: 'blueprint.publish',
  STAGE_CREATE: 'stage.create',
  STAGE_UPDATE: 'stage.update',
  STAGE_DELETE: 'stage.delete',
  STAGE_REORDER: 'stage.reorder',
  RISK_CREATE: 'risk.create',
  RISK_UPDATE: 'risk.update',
  RISK_DELETE: 'risk.delete',
  MINUTE_CREATE: 'minute.create',
  MINUTE_UPDATE: 'minute.update',
  MINUTE_DELETE: 'minute.delete',
  ATTACHMENT_UPLOAD: 'attachment.upload',
  ATTACHMENT_DELETE: 'attachment.delete',
  KB_CREATE: 'kb.create',
  KB_UPDATE: 'kb.update',
  KB_PUBLISH: 'kb.publish',
  KB_ARCHIVE: 'kb.archive',
  KB_RESTORE: 'kb.restore',
  AGENT_CONVERSATION_CREATE: 'agent.conversation_create',
  AGENT_CHAT: 'agent.chat',
  USAGE_VIEW: 'usage.view',
  AI_IMAGE_PARSE: 'ai.image_parse',
  AI_CONFIG_VIEW: 'ai.config_view',
  IMPORT_PUSH: 'import.push',
  IMPORT_APPLY: 'import.apply',
  IMPORT_DELETE: 'import.delete',
  IMPORT_FETCH: 'import.fetch',
} as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditInput {
  actorUserId?: string;
  actorRole: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  /** 显式 IP（@Public 路由无 TenantContext 时由 controller 传入）；默认取 ALS 上下文 */
  ip?: string;
}

/**
 * 审计日志（spec §11：登录、关键数据访问、权限变更）。
 * 经 DRIZZLE 代理写入：受保护路由在请求事务内（随事务回滚，权限变更与审计原子一致）；
 * @Public 路由（login/set-password）无事务上下文，走 base 客户端直接落库。
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly tenantContext: TenantContextService,
  ) {}

  async record(action: AuditAction, input: AuditInput): Promise<void> {
    const ctx = this.tenantContext.current;
    await this.db.insert(auditLogs).values({
      actorUserId: input.actorUserId ?? ctx?.userId,
      actorRole: input.actorRole,
      action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
      ip: input.ip ?? ctx?.ip,
    });
  }
}
