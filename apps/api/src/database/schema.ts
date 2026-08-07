import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
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
 * 问题关联（issue #20，spec 42「关联蓝图/功能/文档」）：多态关联表——
 * 目标可为蓝图（blueprint）/ 会议纪要（minute）/ 知识库文档（kb_document）。
 * 无 FK 到目标（跨表多态无法表达 FK），service 层校验存在性 + 项目归属
 * （blueprint/minute 须同项目；kb 全局文档走 RLS 天然过滤：内部全见、客户只见已发布）；
 * unique(issueId, targetType, targetId) 防重复关联。
 */
export const issueLinks = pgTable(
  'issue_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }), // 链接随问题删
    // 'blueprint' | 'minute' | 'kb_document'
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(), // 无 FK（多态）
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('issue_links_issue_target_unique').on(t.issueId, t.targetType, t.targetId),
    index('issue_links_issue_idx').on(t.issueId),
    index('issue_links_tenant_idx').on(t.tenantId),
    check('issue_links_target_type_check', sql`${t.targetType} in ('blueprint','minute','kb_document')`),
    pgPolicy('issue_links_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
      withCheck: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    }),
    pgPolicy('issue_links_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/**
 * 文档 → RAG 同步任务（issue #21，spec §4.3「发布即同步」）：持久化队列。
 * 发布/归档/恢复与任务行同事务落库（「入队失败则发布回滚」），MQ 事件仅作
 * 事务提交后的唤醒信号（可丢失，worker 启动/定时扫 due 兜底）。
 * 幂等：unique(documentId, documentType, versionNumber, action)；
 * scope 路由：kb 文档（全局）→ internal，蓝图（客户项目文档）→ customer（tenantId 冗余供 RLS）。
 * title 为入队时快照（调试台直接显示，避免多态 join）。
 */
export const documentSyncs = pgTable(
  'document_syncs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id').notNull(), // 无 FK（多态：kb_documents / blueprints）
    documentType: text('document_type').notNull(),
    versionNumber: integer('version_number').notNull(),
    action: text('action').notNull(),
    scope: text('scope').notNull(),
    tenantId: uuid('tenant_id').references(() => customers.id, { onDelete: 'set null' }), // customer scope → 客户 id
    title: text('title').notNull(),
    status: text('status').notNull().default('queued'),
    attempt: integer('attempt').notNull().default(0),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('document_syncs_key_unique').on(t.documentId, t.documentType, t.versionNumber, t.action),
    index('document_syncs_status_idx').on(t.status, t.nextRetryAt),
    check('document_syncs_type_check', sql`${t.documentType} in ('kb_document','blueprint')`),
    check('document_syncs_action_check', sql`${t.action} in ('upsert','delete')`),
    check('document_syncs_scope_check', sql`${t.scope} in ('internal','customer')`),
    check('document_syncs_status_check', sql`${t.status} in ('queued','processing','succeeded','failed')`),
    pgPolicy('document_syncs_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
      withCheck: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    }),
    pgPolicy('document_syncs_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/**
 * 蓝图（issue #16，spec §3.2）：一个项目一份（projectId unique），带版本控制。
 * 当前内容可编辑（工作区）；发布时整体快照到 blueprint_versions（版本 = 文件 + 结构化内容一致快照）。
 * draw.io 文件存对象存储（key 指向 StoragePort），DB 只存 key + 元信息。
 * 数据边界 = 项目：tenantId 冗余供 RLS（同 projects/issues 模式）；应用层再校验项目成员 + 内部维护权限。
 */
export const blueprints = pgTable(
  'blueprints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // 结构化文档（spec §3.2：业务需求 / 模块功能范围 / 配置说明 / 流程描述）
    businessRequirements: text('business_requirements'),
    moduleScope: text('module_scope'),
    configNotes: text('config_notes'),
    processDescription: text('process_description'),
    // draw.io 文件（对象存储 key + 元信息；创建即必传，PATCH 可保留原文件）
    drawioKey: text('drawio_key').notNull(),
    drawioName: text('drawio_name').notNull(),
    drawioContentType: text('drawio_content_type').notNull(),
    drawioSize: integer('drawio_size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('blueprints_project_unique').on(t.projectId), // 一个项目一份蓝图
    index('blueprints_tenant_idx').on(t.tenantId),
    pgPolicy('blueprints_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
      withCheck: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    }),
    pgPolicy('blueprints_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/** 蓝图版本快照（发布时冻结：字段 + 文件 key 一致快照，不可变；版本号每蓝图独立递增） */
export const blueprintVersions = pgTable(
  'blueprint_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    blueprintId: uuid('blueprint_id')
      .notNull()
      .references(() => blueprints.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(), // 1-based，每蓝图连续递增
    businessRequirements: text('business_requirements'),
    moduleScope: text('module_scope'),
    configNotes: text('config_notes'),
    processDescription: text('process_description'),
    drawioKey: text('drawio_key').notNull(),
    drawioName: text('drawio_name').notNull(),
    drawioContentType: text('drawio_content_type').notNull(),
    drawioSize: integer('drawio_size').notNull(),
    publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }), // 发布人
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('blueprint_versions_blueprint_version_unique').on(t.blueprintId, t.version),
    index('blueprint_versions_blueprint_idx').on(t.blueprintId),
    index('blueprint_versions_tenant_idx').on(t.tenantId),
    pgPolicy('blueprint_versions_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
      withCheck: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    }),
    pgPolicy('blueprint_versions_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/**
 * 实施阶段（issue #17，spec §3.3）：基于标准阶段模板在项目内实例化，可增删/排序/状态流转。
 * 状态 = 未开始/进行中/已完成/已暂停（应用层自由流转，无 issues 式严格状态机）。
 * 数据边界 = 项目：tenantId 冗余供 RLS（同 projects/issues 模式）；应用层再校验成员 + 内部维护权限。
 */
export const projectStages = pgTable(
  'project_stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    templateKey: text('template_key'), // 来源模板 key（STAGE_TEMPLATES 常量；自定义阶段为 null）
    name: text('name').notNull(),
    description: text('description'),
    // 'not_started' | 'in_progress' | 'completed' | 'paused'（未开始/进行中/已完成/已暂停）
    status: text('status').notNull().default('not_started'),
    sortOrder: integer('sort_order').notNull().default(0), // 项目内排序（重排时整体重写）
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('project_stages_tenant_idx').on(t.tenantId),
    index('project_stages_project_idx').on(t.projectId),
    check('project_stages_status_check', sql`${t.status} in ('not_started','in_progress','completed','paused')`),
    pgPolicy('project_stages_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
      withCheck: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    }),
    pgPolicy('project_stages_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/**
 * 风险点（issue #17，spec §3.3）：项目级，可关联具体阶段（stageId set null——阶段删除后风险保留）。
 * 字段：描述、等级（高/中/低）、状态（未处理/处理中/已解决）、负责人（内部）。
 */
export const projectRisks = pgTable(
  'project_risks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    stageId: uuid('stage_id').references(() => projectStages.id, { onDelete: 'set null' }), // 关联阶段
    description: text('description').notNull(),
    // 'high' | 'medium' | 'low'（高/中/低）
    level: text('level').notNull().default('medium'),
    // 'open' | 'in_progress' | 'resolved'（未处理/处理中/已解决）
    status: text('status').notNull().default('open'),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }), // 负责人（内部）
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('project_risks_tenant_idx').on(t.tenantId),
    index('project_risks_project_idx').on(t.projectId),
    index('project_risks_stage_idx').on(t.stageId),
    check('project_risks_level_check', sql`${t.level} in ('high','medium','low')`),
    check('project_risks_status_check', sql`${t.status} in ('open','in_progress','resolved')`),
    pgPolicy('project_risks_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
      withCheck: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    }),
    pgPolicy('project_risks_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/**
 * 会议纪要（issue #18，spec §3.4）：项目内会议记录。
 * 结构化字段（主题/日期/参会人）+ 富文本正文（HTML）+ 附件（对象存储，DB 只存元信息）。
 * 数据边界 = 项目：tenantId 冗余供 RLS（同 projects/issues 模式）；应用层再校验成员 + 内部维护权限。
 */
export const meetingMinutes = pgTable(
  'meeting_minutes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    // date 模式默认 string（'YYYY-MM-DD'），DTO 无需 toISOString
    meetingDate: date('meeting_date').notNull(),
    participants: text('participants'), // 参会人（纯文本名单，Phase 1 不做用户关联）
    body: text('body'), // 富文本正文（HTML）
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }), // 创建人
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('meeting_minutes_tenant_idx').on(t.tenantId),
    index('meeting_minutes_project_idx').on(t.projectId),
    pgPolicy('meeting_minutes_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
      withCheck: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    }),
    pgPolicy('meeting_minutes_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/**
 * 纪要附件（issue #18）：文件本体在对象存储（storageKey 指向 StoragePort），DB 只存元信息。
 * 删纪要级联删附件行（minuteId onDelete cascade；storage 对象由 service 先删）。
 */
export const minuteAttachments = pgTable(
  'minute_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    minuteId: uuid('minute_id')
      .notNull()
      .references(() => meetingMinutes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    storageKey: text('storage_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('minute_attachments_minute_idx').on(t.minuteId),
    index('minute_attachments_tenant_idx').on(t.tenantId),
    pgPolicy('minute_attachments_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
      withCheck: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    }),
    pgPolicy('minute_attachments_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/**
 * 知识库文档（issue #19，spec §4.1/§4.3）：内部知识库 = 全局（不挂客户/项目——
 * 客户知识库 = 内部 KB + 本项目文档是逻辑视图，spec §4.2）。
 * 分类（操作手册/FAQ/最佳实践）+ 形态（在线 Markdown / 上传文件）+ 生命周期
 * （草稿 → 已发布 → 已归档，归档即下架可恢复）。发布动作是 RAG 同步触发点（切片 11）。
 * RLS 与项目级域不同（无 tenantId）：内部全权（读写）+ 已发布全员可读（含客户）。
 */
export const kbDocuments = pgTable(
  'kb_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // 归属：NULL = 全局文档（内部知识库，issue #19 语义不变）；非 NULL = 项目文档
    // （客户知识库，issue #26 手册产物；tenantId 冗余供 RLS 租户过滤）
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    tenantId: uuid('tenant_id').references(() => customers.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    // 'manual' | 'faq' | 'best_practice'（操作手册/FAQ/最佳实践）
    category: text('category').notNull(),
    // 'markdown' | 'file'（在线编辑仅 Markdown；文件类为上传 + 覆盖更新）
    docType: text('doc_type').notNull(),
    // 'draft' | 'published' | 'archived'
    status: text('status').notNull().default('draft'),
    // 'manual' | 'online_help'（issue #25：内部创作 / 外部导入只读；online_help 不可在线编辑）
    source: text('source').notNull().default('manual'),
    // online_help 来源文档唯一键 = `${channel}:${sourceKey}`（通道前缀隔离键空间）
    externalKey: text('external_key'),
    // 当前已应用内容的 sha256（apply 幂等 + 去重判定）
    fingerprint: text('fingerprint'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }), // 创建人
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('kb_documents_category_status_idx').on(t.category, t.status),
    index('kb_documents_tenant_idx').on(t.tenantId),
    index('kb_documents_project_idx').on(t.projectId),
    uniqueIndex('kb_documents_external_key_unique')
      .on(t.source, t.externalKey)
      .where(sql`${t.source} = 'online_help' and ${t.externalKey} is not null`),
    check('kb_documents_source_check', sql`${t.source} in ('manual','online_help')`),
    pgPolicy('kb_documents_internal_manage', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
    // 已发布可读（issue #26 演进）：NULL=全局文档全员可见（原语义）；项目文档仅所属租户可见。
    // 注意：permissive 策略 OR 语义——此策略 DROP 重建必须与 DB 一致，旧策略留存会向全客户泄漏项目文档
    pgPolicy('kb_documents_read_published', {
      as: 'permissive',
      for: 'select',
      to: appTenantUser,
      using: sql`${t.status} = 'published' and (${t.tenantId} is null or ${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`,
    }),
  ],
).enableRLS();

/**
 * 知识库文档版本（issue #19）：版本 = 全字段快照（title/category/body 或文件三件套），
 * 发布时生成（versionNumber = max+1，1-based）；未发布草稿版本 versionNumber = null
 * （Postgres unique 忽略 null，允许多个草稿行——service 层保证每文档最多一个草稿版本）。
 * 文件类文档文件本体在对象存储（storageKey 指向 StoragePort），DB 只存元信息；
 * 删文档级联删版本行（documentId onDelete cascade；storage 对象由 service 先删）。
 */
export const kbDocumentVersions = pgTable(
  'kb_document_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => kbDocuments.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number'), // 发布时分配；草稿版本为 null
    isPublished: boolean('is_published').notNull().default(false),
    title: text('title').notNull(), // 全字段快照（重新发布才生效对标题/分类同样成立）
    category: text('category').notNull(),
    body: text('body'), // Markdown 正文（markdown 类）
    fileName: text('file_name'), // 文件类：原名/类型/字节数/storage key
    contentType: text('content_type'),
    size: integer('size'),
    storageKey: text('storage_key'),
    publishedById: uuid('published_by_id').references(() => users.id, { onDelete: 'set null' }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('kb_document_versions_doc_version_unique').on(t.documentId, t.versionNumber),
    index('kb_document_versions_doc_idx').on(t.documentId),
    pgPolicy('kb_document_versions_internal_manage', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
    pgPolicy('kb_document_versions_read_published', {
      as: 'permissive',
      for: 'select',
      to: appTenantUser,
      using: sql`exists(select 1 from kb_documents d where d.id = ${t.documentId} and d.status = 'published')`,
    }),
  ],
).enableRLS();

/**
 * Online help 导入暂存队列（issue #25，spec §4.4）：导入 API（外部推送）与定时拉取
 * （平台拉外部文档清单）双通道的唯一入队入口，消费 worker 增量落库。
 * 幂等：unique(source, sourceKey, action)——同源同键重复推送去重（指纹相同 → 仅
 * duplicateCount+1；指纹变化 → 原地重置 pending 重新消费）；body/base64 原样暂存
 * （apply 时才解码/写存储）。全局内部域：RLS 单策略 internal_bypass（同 ai_conversations
 * 先例，客户连接 0 行 fail closed）。documentId 无 FK（apply 后关联，文档会被硬删）。
 */
export const importStagedDocuments = pgTable(
  'import_staged_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // 'api' | 'fetch'（externalKey = `${source}:${sourceKey}` 前缀）
    source: text('source').notNull(),
    sourceKey: text('source_key').notNull(), // 外部源文档唯一键（原样存）
    action: text('action').notNull(), // 'upsert' | 'delete'
    fingerprint: text('fingerprint').notNull(), // sha256（markdown → body UTF-8；file → 解码 buffer）
    title: text('title').notNull(),
    category: text('category').notNull(), // 'manual' | 'faq' | 'best_practice'
    docType: text('doc_type').notNull(), // 'markdown' | 'file'
    body: text('body'), // markdown 正文
    fileName: text('file_name'), // 文件类三件套
    contentType: text('content_type'),
    base64: text('base64'), // 文件类原样暂存（≤8M 字符 ≈6MB，同 kb 上传限）
    metadata: jsonb('metadata'),
    documentId: uuid('document_id'), // apply 后关联的 kb 文档（无 FK——文档会被硬删）
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('pending'), // 'pending' | 'processing' | 'processed' | 'failed'
    attempt: integer('attempt').notNull().default(0),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    lastError: text('last_error'),
    duplicateCount: integer('duplicate_count').notNull().default(0), // 重复推送/拉取计数（去重日志可见）
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('import_staged_key_unique').on(t.source, t.sourceKey, t.action), // 幂等键
    index('import_staged_status_idx').on(t.status, t.nextRetryAt),
    index('import_staged_source_key_idx').on(t.sourceKey),
    check('import_staged_source_check', sql`${t.source} in ('api','fetch')`),
    check('import_staged_action_check', sql`${t.action} in ('upsert','delete')`),
    check('import_staged_category_check', sql`${t.category} in ('manual','faq','best_practice')`),
    check('import_staged_doc_type_check', sql`${t.docType} in ('markdown','file')`),
    check(
      'import_staged_status_check',
      sql`${t.status} in ('pending','processing','processed','failed')`,
    ),
    pgPolicy('import_staged_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/**
 * 操作手册生成会话（issue #26，spec §6）：「选蓝图版本 → 分章节生成 → 逐章审校 →
 * 组装 → 落项目知识库」的完整流程。数据边界 = 项目（tenantId 冗余 RLS，同 issues
 * 模式）；维护 = manual:generate（仅内部/超管，spec §2.4 手册维护仅内部）；查看 = 项目成员。
 * status：in_progress（生成/审校中）→ published（已落 kb 草稿）；蓝图新版本发布不覆盖
 * 本会话（AC4 stale 读时计算），再生成 = 新会话新草稿。
 */
export const manualGenerations = pgTable(
  'manual_generations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    blueprintId: uuid('blueprint_id')
      .notNull()
      .references(() => blueprints.id, { onDelete: 'cascade' }),
    blueprintVersion: integer('blueprint_version').notNull(), // 生成时的蓝图版本（AC4 stale 依据）
    title: text('title').notNull(),
    // 'in_progress' | 'published'（已落 kb 草稿）
    status: text('status').notNull().default('in_progress'),
    kbDocumentId: uuid('kb_document_id').references(() => kbDocuments.id, {
      onDelete: 'set null',
    }), // 组装发布的 kb 文档（草稿态）
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('manual_generations_tenant_idx').on(t.tenantId),
    index('manual_generations_project_idx').on(t.projectId),
    index('manual_generations_blueprint_idx').on(t.blueprintId),
    check('manual_generations_status_check', sql`${t.status} in ('in_progress','published')`),
    pgPolicy('manual_generations_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
      withCheck: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    }),
    pgPolicy('manual_generations_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/**
 * 手册章节（issue #26）：生成会话的分章节产物。seq = 1-based 固定顺序（不可重排）；
 * outline 由 LLM 大纲调用产出（生成正文时注入）；status：pending（大纲已定未生成正文）
 * → ready（AI 生成）→ edited（人工审校；重新生成覆盖 content_md 回到 ready）。
 */
export const manualChapters = pgTable(
  'manual_chapters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    generationId: uuid('generation_id')
      .notNull()
      .references(() => manualGenerations.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(), // 1-based 章节顺序
    title: text('title').notNull(),
    outline: text('outline'), // 章节大纲（AI 规划；生成正文时注入）
    contentMd: text('content_md'), // 正文（Markdown；生成/审校后更新）
    // 'pending' | 'ready' | 'edited'
    status: text('status').notNull().default('pending'),
    aiGeneratedAt: timestamp('ai_generated_at', { withTimezone: true }),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('manual_chapters_generation_seq_unique').on(t.generationId, t.seq),
    index('manual_chapters_generation_idx').on(t.generationId),
    index('manual_chapters_tenant_idx').on(t.tenantId),
    check('manual_chapters_status_check', sql`${t.status} in ('pending','ready','edited')`),
    pgPolicy('manual_chapters_tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
      withCheck: sql`${t.tenantId} = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
    }),
    pgPolicy('manual_chapters_internal_bypass', {
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

/**
 * 内部客服 AI Agent 会话（issue #22，spec §5）：多轮对话 + 回看/继续。
 * 归属 = 用户本人：RLS 单策略 internal_bypass（客户连接 0 行 fail closed），
 * 内部用户互相隔离靠应用层 WHERE userId（RLS 拦不住同角色间的水平越权）。
 * thread_id（LangGraph checkpoint） = aiConversations.id。
 */
export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('新会话'), // 首问前 20 字快照（列表显示）
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_conversations_user_idx').on(t.userId),
    pgPolicy('ai_conversations_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/**
 * Agent 消息投影（会话回看/继续的查询友好层）：checkpointer 是 agent 运行时记忆
 * 事实源（langgraph_checkpoints），aiMessages 是展示/审计投影——两者在同一请求
 * 事务内双写，原子一致（分歧仅存于 interrupt/fork，本图无）。citations 仅 assistant 行。
 */
export const aiMessages = pgTable(
  'ai_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    citations: jsonb('citations'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_messages_conversation_idx').on(t.conversationId, t.createdAt),
    check('ai_messages_role_check', sql`${t.role} in ('user','assistant')`),
    pgPolicy('ai_messages_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/**
 * LangGraph.js checkpoint 持久化（issue #22）：BaseCheckpointSaver 数据库适配器表。
 * checkpointId 是 LangGraph UUID（v6）→ text 列（uuid 类型会报格式错误）；
 * checkpoint/metadata 为 JsonPlusSerializer 序列化后的 JSON 文本（UTF-8 字符串，
 * loadsTyped 接受 string）。
 */
export const langgraphCheckpoints = pgTable(
  'langgraph_checkpoints',
  {
    threadId: text('thread_id').notNull(), // = ai_conversations.id
    checkpointId: text('checkpoint_id').notNull(),
    parentCheckpointId: text('parent_checkpoint_id'),
    checkpoint: jsonb('checkpoint').notNull(),
    metadata: jsonb('metadata').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.checkpointId] }),
    index('langgraph_checkpoints_parent_idx').on(t.threadId, t.parentCheckpointId),
    pgPolicy('langgraph_checkpoints_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/** LangGraph pending writes（putWrites；无 interrupt 的线性图多为空，接口须实现） */
export const langgraphCheckpointWrites = pgTable(
  'langgraph_checkpoint_writes',
  {
    threadId: text('thread_id').notNull(),
    checkpointId: text('checkpoint_id').notNull(),
    taskId: text('task_id').notNull(),
    idx: integer('idx').notNull(),
    write: jsonb('write').notNull(), // [channel, value] 或 [taskId, channel, value]（含错误索引）
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.checkpointId, t.taskId, t.idx] }),
    pgPolicy('langgraph_checkpoint_writes_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

/**
 * AI Token 用量计量（issue #23，spec #77–#79）：每次 LLM 调用统一经 LLMClient
 * 记录（UsageRecordingLlmClient wrapper，chat 成功后同请求事务落库）。
 * 内部专属统计表：RLS 单策略 internal_bypass（客户连接 0 行 fail closed），
 * 内部全权限——用量是管理视图，不做 userId 过滤（区别于 ai_conversations）。
 * customerId/projectId 为归属预留：本期唯一场景 agent 客服无项目/客户绑定 →
 * null（统计「未归属」组），#26 手册生成按项目归属后自然填充。
 * costUsd 预留 per-call 成本（真实驱动填；Phase 2 客户 AI 成本视图 =
 * sum(costUsd) + RAG Index 规格费 21.6 元/月/客户）。
 */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scene: text('scene').notNull(), // spec 定稿 4 场景（本期仅 agent 产生数据）
    model: text('model').notNull(), // memory fake → 'memory'；真实驱动填模型名
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }), // 调用发起者
    conversationId: uuid('conversation_id').references(() => aiConversations.id, {
      onDelete: 'set null',
    }), // agent 会话追溯
    costUsd: numeric('cost_usd', { precision: 12, scale: 4 }), // 预留：真实驱动填 per-call 成本
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_usage_created_at_idx').on(t.createdAt), // 趋势 date_trunc
    index('ai_usage_customer_idx').on(t.customerId),
    index('ai_usage_project_idx').on(t.projectId),
    index('ai_usage_scene_idx').on(t.scene),
    index('ai_usage_model_idx').on(t.model),
    index('ai_usage_conversation_idx').on(t.conversationId),
    check(
      'ai_usage_scene_check',
      sql`${t.scene} in ('agent','document_parsing','manual_generation','embedding')`,
    ),
    pgPolicy('ai_usage_internal_bypass', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
  ],
).enableRLS();

export type AiUsageRow = typeof aiUsage.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;
export type UserTenantRow = typeof userTenants.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type ProjectMemberRow = typeof projectMembers.$inferSelect;
export type IssueRow = typeof issues.$inferSelect;
export type IssueCommentRow = typeof issueComments.$inferSelect;
export type IssueLinkRow = typeof issueLinks.$inferSelect;
export type DocumentSyncRow = typeof documentSyncs.$inferSelect;
export type BlueprintRow = typeof blueprints.$inferSelect;
export type BlueprintVersionRow = typeof blueprintVersions.$inferSelect;
export type ProjectStageRow = typeof projectStages.$inferSelect;
export type ProjectRiskRow = typeof projectRisks.$inferSelect;
export type MeetingMinuteRow = typeof meetingMinutes.$inferSelect;
export type MinuteAttachmentRow = typeof minuteAttachments.$inferSelect;
export type KbDocumentRow = typeof kbDocuments.$inferSelect;
export type KbDocumentVersionRow = typeof kbDocumentVersions.$inferSelect;
export type ImportStagedRow = typeof importStagedDocuments.$inferSelect;
export type ManualGenerationRow = typeof manualGenerations.$inferSelect;
export type ManualChapterRow = typeof manualChapters.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;
export type AiConversationRow = typeof aiConversations.$inferSelect;
export type AiMessageRow = typeof aiMessages.$inferSelect;
export type LanggraphCheckpointRow = typeof langgraphCheckpoints.$inferSelect;
export type LanggraphCheckpointWriteRow = typeof langgraphCheckpointWrites.$inferSelect;
