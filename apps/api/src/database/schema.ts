import {
  boolean,
  char,
  index,
  pgTable,
  text,
  timestamp,
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

export type UserRow = typeof users.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
