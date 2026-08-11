import {
  Global,
  Inject,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { TenantContextService } from './tenant-context.service';

/**
 * DRIZZLE：业务代码唯一入口。ALS 感知代理——请求事务激活时，
 * 一切查询/事务自动转发到绑定 GUC 的 tx 客户端，业务代码零感知多租户。
 */
export const DRIZZLE = Symbol('DRIZZLE');
/**
 * RAW_DB：基础客户端（无 RLS GUC 绑定）。仅租户解析与事务编排用，
 * 业务代码严禁注入——裸连接在 RLS 表上会 fail closed 或绕过租户约束。
 */
export const RAW_DB = Symbol('RAW_DB');
/**
 * POSTGRES_CLIENT：postgres.js 原生连接池（RAW_DB/DRIZZLE 的底座）。
 * 模块 onApplicationShutdown 时统一 end()——app.close() 不自动关闭它，
 * e2e 单进程串行多 app 时连接累积会打爆 max_connections 导致后续文件
 * beforeAll 挂死（stages 30s 超时即此根因）。
 */
export const POSTGRES_CLIENT = Symbol('POSTGRES_CLIENT');
export type Database = PostgresJsDatabase<typeof schema>;

/** ALS 感知代理：上下文存在请求事务时转发 tx 客户端，否则走 base */
function createTenantAwareProxy(
  base: Database,
  ctx: TenantContextService,
): Database {
  return new Proxy({} as Database, {
    get(_target, prop: string | symbol): unknown {
      const active = ctx.current;
      const target = (active ? active.tx : base) as unknown as Record<
        string | symbol,
        unknown
      >;
      const value = target[prop];
      // 方法必须 bind 目标客户端，否则 db.transaction/select 里的 this 会丢
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Drizzle 连接工厂：全局单例注入令牌。
 * RLS 的每事务 SET LOCAL 在此连接上展开（spec 接缝）——见 tenant.interceptor.ts。
 */
@Global()
@Module({})
export class DrizzleModule implements OnApplicationShutdown {
  constructor(
    @Inject(POSTGRES_CLIENT) private readonly client: postgres.Sql,
  ) {}

  /** app.close()/SIGTERM 时关闭连接池（优雅退出；e2e 串行多 app 不累积连接） */
  async onApplicationShutdown(): Promise<void> {
    await this.client.end();
  }

  static forRoot(): DynamicModule {
    return {
      module: DrizzleModule,
      global: true,
      providers: [
        TenantContextService,
        {
          provide: POSTGRES_CLIENT,
          inject: [ConfigService],
          useFactory: (config: ConfigService): postgres.Sql =>
            postgres(config.getOrThrow<string>('DATABASE_URL')),
        },
        {
          provide: RAW_DB,
          inject: [POSTGRES_CLIENT],
          useFactory: (client: postgres.Sql): Database =>
            drizzle(client, { schema }),
        },
        {
          provide: DRIZZLE,
          inject: [RAW_DB, TenantContextService],
          useFactory: (
            base: Database,
            ctx: TenantContextService,
          ): Database => createTenantAwareProxy(base, ctx),
        },
      ],
      exports: [DRIZZLE, RAW_DB, TenantContextService],
    };
  }
}
