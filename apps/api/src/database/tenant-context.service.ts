import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { Database } from './database.module';

/**
 * 请求级租户上下文（AsyncLocalStorage）。
 * TenantInterceptor 在每个请求事务内注入；业务代码经 DRIZZLE 代理
 * 自动把查询转发到绑定同一连接（已 SET LOCAL GUC）的 tx 客户端。
 */
export interface TenantContext {
  /** 请求绑定的事务客户端（同一连接上已 SET LOCAL app.tenant_id / app.is_internal） */
  tx: Database;
  /** 客户用户 → customer id；内部用户 → null */
  tenantId: string | null;
  isInternal: boolean;
  userId: string;
  /** 客户端 IP（审计日志用；@Public 路由无上下文时由 controller 显式传入） */
  ip?: string;
}

@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TenantContext>();

  run<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> {
    return this.storage.run(ctx, fn);
  }

  get current(): TenantContext | undefined {
    return this.storage.getStore();
  }
}
