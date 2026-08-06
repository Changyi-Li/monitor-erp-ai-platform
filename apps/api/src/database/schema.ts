import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
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
    title: text('title').notNull(),
    // 'manual' | 'faq' | 'best_practice'（操作手册/FAQ/最佳实践）
    category: text('category').notNull(),
    // 'markdown' | 'file'（在线编辑仅 Markdown；文件类为上传 + 覆盖更新）
    docType: text('doc_type').notNull(),
    // 'draft' | 'published' | 'archived'
    status: text('status').notNull().default('draft'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }), // 创建人
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('kb_documents_category_status_idx').on(t.category, t.status),
    pgPolicy('kb_documents_internal_manage', {
      as: 'permissive',
      for: 'all',
      to: appTenantUser,
      using: sql`current_setting('app.is_internal', true) = 'true'`,
      withCheck: sql`current_setting('app.is_internal', true) = 'true'`,
    }),
    pgPolicy('kb_documents_read_published', {
      as: 'permissive',
      for: 'select',
      to: appTenantUser,
      using: sql`${t.status} = 'published'`,
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
export type BlueprintRow = typeof blueprints.$inferSelect;
export type BlueprintVersionRow = typeof blueprintVersions.$inferSelect;
export type ProjectStageRow = typeof projectStages.$inferSelect;
export type ProjectRiskRow = typeof projectRisks.$inferSelect;
export type MeetingMinuteRow = typeof meetingMinutes.$inferSelect;
export type MinuteAttachmentRow = typeof minuteAttachments.$inferSelect;
export type KbDocumentRow = typeof kbDocuments.$inferSelect;
export type KbDocumentVersionRow = typeof kbDocumentVersions.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;
