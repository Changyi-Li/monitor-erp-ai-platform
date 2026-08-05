import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// 显式加载 apps/api/.env.test 并强制覆盖（vite/vitest 可能已自动加载 .env）
config({ path: '.env.test', override: true });

/**
 * e2e 前置：编程式应用迁移 + 清库（幂等，每轮测试干净起点）。
 * 红线：只允许操作测试库 monitor_erp_test，防误删开发数据。
 */
export async function resetTestDb(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || !url.includes('monitor_erp_test')) {
    throw new Error('e2e 仅允许连接测试库 monitor_erp_test，已中止操作');
  }
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: 'src/database/migrations' });
  await client`TRUNCATE users, refresh_tokens`;
  await client.end();
}
