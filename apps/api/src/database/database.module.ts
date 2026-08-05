import { Global, Module, type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export const DRIZZLE = Symbol('DRIZZLE');
export type Database = PostgresJsDatabase<typeof schema>;

/**
 * Drizzle 连接工厂：全局单例注入令牌。
 * 后续 RLS 的每事务 SET LOCAL 在此连接上展开（spec 接缝）。
 */
@Global()
@Module({})
export class DrizzleModule {
  static forRoot(): DynamicModule {
    return {
      module: DrizzleModule,
      global: true,
      providers: [
        {
          provide: DRIZZLE,
          inject: [ConfigService],
          useFactory: (config: ConfigService): Database => {
            const client = postgres(config.getOrThrow<string>('DATABASE_URL'));
            return drizzle(client, { schema });
          },
        },
      ],
      exports: [DRIZZLE],
    };
  }
}
