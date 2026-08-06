import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// 显式加载 apps/api/.env.test 并强制覆盖（vite/vitest 可能已自动加载 .env）
config({ path: '.env.test', override: true });

/** 受限应用角色在测试库的口令（与 .env.test 的 DATABASE_URL 一致） */
const APP_ROLE_TEST_PASSWORD = 'app_tenant_user_pw_test';

/**
 * e2e 前置：编程式应用迁移 + 清库（幂等，每轮测试干净起点）。
 * 红线：只允许操作测试库 monitor_erp_test，防误删开发数据。
 * 全部以 owner 连接执行（migrate 的 CREATE ROLE/GRANT 需 owner 权限）。
 */
export async function resetTestDb(): Promise<void> {
  const appUrl = process.env.DATABASE_URL;
  const ownerUrl = process.env.DATABASE_OWNER_URL;
  if (!appUrl?.includes('monitor_erp_test') || !ownerUrl?.includes('monitor_erp_test')) {
    throw new Error('e2e 仅允许连接测试库 monitor_erp_test（DATABASE_URL 与 DATABASE_OWNER_URL 必须指向它），已中止操作');
  }
  const client = postgres(ownerUrl, { max: 1 });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: 'src/database/migrations' });
  // 迁移创建的 app_tenant_user 无 LOGIN（pgRole 不支持），测试连接需开启 + 设口令（幂等）。
  // DDL 不支持绑定参数（$1），口令为固定测试常量，直接字面量拼接。
  await client.unsafe(
    `alter role "app_tenant_user" with login password '${APP_ROLE_TEST_PASSWORD}'`,
  );
  // 单语句 TRUNCATE 全部表（含 FK 引用表）
  await client`TRUNCATE users, refresh_tokens, customers, projects, user_tenants, project_members, issues, issue_comments, issue_links, blueprints, blueprint_versions, project_stages, project_risks, meeting_minutes, minute_attachments, kb_documents, kb_document_versions, document_syncs, ai_conversations, ai_messages, langgraph_checkpoints, langgraph_checkpoint_writes, ai_usage, audit_logs`;
  await client.end();
}

/** 测试 seed 用的 owner 连接（迁移后表所有者可绕过 RLS 直写种子数据） */
export function connectOwner(): postgres.Sql {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url?.includes('monitor_erp_test')) {
    throw new Error('seed 仅允许连接测试库 monitor_erp_test，已中止操作');
  }
  return postgres(url, { max: 1 });
}
