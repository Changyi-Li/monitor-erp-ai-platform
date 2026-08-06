import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  index,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * RLS 接缝：spec 的 RLS/pgPolicy/tenant_id 属于后续业务表 issue，
 * 本表刻意保持"无租户"简单形态，RLS 后续加入。
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(), // 服务层统一 lowercase 后存储
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull().default(''),
    // 'super_admin' | 'internal' | 'customer'（RBAC issue #13；客户细粒度角色存 project_members）
    role: text('role').notNull().default('internal'),
    isActive: boolean('is_active').notNull().default(true),
    // 邀请设密（RBAC issue #13）：invite_token_hash 非空 = 账号待激活（isActive=false）
    inviteTokenHash: char('invite_token_hash', { length: 64 }), // sha256 hex，一次性
    inviteExpiresAt: timestamp('invite_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_invite_token_hash_idx').on(t.inviteTokenHash)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: char('token_hash', { length: 64 }).notNull().unique(), // sha256 hex，落库绝不存明文 token
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('refresh_tokens_user_idx').on(t.userId),
    index('refresh_tokens_expires_idx').on(t.expiresAt), // 为后续清理过期行铺路
  ],
);

/**
 * 受限应用角色：非表 owner、无 BYPASSRLS。迁移生成 CREATE ROLE（无 LOGIN，
 * 密码经 ALTER ROLE 外置设置——测试在 setup 做，生产走部署文档，库里永不存口令）。
 * 所有业务表 RLS 策略的 to 目标；owner 连接（迁移/管理）不受 RLS 约束。
 */
export const appTenantUser = pgRole('app_tenant_user');

/** 租户注册表（客户=租户）。无 tenant_id 列，策略用主键对 GUC 自隔离。 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    industry: text('industry'),
    region: text('region'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    pgPolicy('customers_tenant_self', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      // NULLIF 归一空串：自定义 GUC 经 SET LOCAL 提交后会残留 ''（PG 怪癖，非 NULL），
      // ''::uuid 会 22P02 报 500；NULLIF('')→NULL→fail closed
      using: sql`${t.id} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
      withCheck: sql`${t.id} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    }),
    pgPolicy('customers_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      // withCheck 必需：否则客户角色 INSERT 可借旁路策略无约束写入任意 id
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/**
 * 用户-租户映射（平台级成员表，与 users 同级，不加 RLS）。
 * 租户解析在应用层拦截器完成（事务外 RAW_DB 查询）。
 */
export const userTenants = pgTable(
  'user_tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('user_tenants_user_customer_unique').on(t.userId, t.customerId),
    index('user_tenants_user_idx').on(t.userId),
    index('user_tenants_customer_idx').on(t.customerId),
  ],
);

/** 数据隔离边界表：客户 1:N 项目。RLS 主战场。 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('projects_tenant_idx').on(t.tenantId),
    pgPolicy('projects_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      // NULLIF 归一空串：自定义 GUC 经 SET LOCAL 提交后会残留 ''（PG 怪癖，非 NULL），
      // ''::uuid 会 22P02 报 500；NULLIF('')→NULL→fail closed
      using: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
      withCheck: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    }),
    pgPolicy('projects_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/**
 * 项目成员（数据边界 = 项目，spec §2.1：项目成员 = 用户 + 项目 + 角色）。
 * 平台级成员表，与 user_tenants 同级不加 RLS——项目级权限在应用层强制
 * （MembersService 每请求解析），RLS 兜底仍是客户级（tenant GUC）。
 */
export const projectMembers = pgTable(
  'project_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('project_members_role_check', sql`${t.role} in ('project_manager','key_user','regular_user')`),
    unique('project_members_project_user_unique').on(t.projectId, t.userId),
    index('project_members_user_idx').on(t.userId),
    index('project_members_project_idx').on(t.projectId),
  ],
);

/**
 * 问题清单（issue #15，spec §3.5）：项目内待办/缺陷条目。
 * 数据边界 = 项目：tenantId 冗余存储供 RLS（同 projects 模式），应用层再校验项目成员。
 * 枚举 = text + check()（仓库无 pgEnum 先例，同 project_members.role）。
 */
export const issues = pgTable(
  'issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    // 'bug' | 'feature' | 'question'（缺陷/需求/咨询）
    type: text('type').notNull().default('bug'),
    // 'function' | 'data' | 'usage' | 'technical' | 'optimization'（功能/数据/使用/技术/优化）
    category: text('category').notNull().default('function'),
    // 'high' | 'medium' | 'low'
    priority: text('priority').notNull().default('medium'),
    // 严格线性状态机：'new' → 'in_progress' → 'resolved' → 'closed'（应用层 canTransition 强制）
    status: text('status').notNull().default('new'),
    reporterId: uuid('reporter_id').references(() => users.id, { onDelete: 'set null' }), // 提交人
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }), // 内部负责人
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('issues_tenant_idx').on(t.tenantId),
    index('issues_project_idx').on(t.projectId),
    check('issues_type_check', sql`${t.type} in ('bug','feature','question')`),
    check('issues_category_check', sql`${t.category} in ('function','data','usage','technical','optimization')`),
    check('issues_priority_check', sql`${t.priority} in ('high','medium','low')`),
    check('issues_status_check', sql`${t.status} in ('new','in_progress','resolved','closed')`),
    pgPolicy('issues_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
      withCheck: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    }),
    pgPolicy('issues_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/** 问题评论（issue #15）：作者名经应用层 join users 补 displayName 返回。 */
export const issueComments = pgTable(
  'issue_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('issue_comments_issue_idx').on(t.issueId),
    index('issue_comments_tenant_idx').on(t.tenantId),
    pgPolicy('issue_comments_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
      withCheck: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    }),
    pgPolicy('issue_comments_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/**
 * 审计日志（登录/关键数据访问/权限变更，spec §11 安全要求）。
 * 平台级表不加 RLS：受限角色经 ALTER DEFAULT PRIVILEGES 自动获得 CRUD。
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorRole: text('actor_role').notNull(),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    metadata: jsonb('metadata'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_logs_created_at_idx').on(t.createdAt)],
);

export type UserRow = typeof users.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;
export type UserTenantRow = typeof userTenants.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type ProjectMemberRow = typeof projectMembers.$inferSelect;
export type IssueRow = typeof issues.$inferSelect;
export type IssueCommentRow = typeof issueComments.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;
