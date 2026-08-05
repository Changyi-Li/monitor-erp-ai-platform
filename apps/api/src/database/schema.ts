import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  index,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * RLS 接缝：spec 的 RLS/pgPolicy/tenant_id 属于后续业务表 issue，
 * 本表刻意保持"无租户"简单形态，RLS 后续加入。
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(), // 服务层统一 lowercase 后存储
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull().default(''),
  role: text('role').notNull().default('internal'), // 'internal' | 'customer'，RBAC issue 再演进
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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

export type UserRow = typeof users.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;
export type UserTenantRow = typeof userTenants.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
