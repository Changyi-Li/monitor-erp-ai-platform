import { Global, Module, type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE, type Database } from '../../database/database.module';
import { TenantContextService } from '../../database/tenant-context.service';
import { MemoryLlmAdapter } from './memory-llm.adapter';
import type { LLMClient } from './llm-client.port';
import { UsageRecordingLlmClient } from './usage-recording-llm.adapter';

export const LLM = Symbol('LLM');

/**
 * LLM 门面适配工厂：切换真实供应商 = 改 LLM_DRIVER 配置，业务代码零改动（切片 13/14 接入）。
 * 返回的客户端包 UsageRecordingLlmClient（issue #23 用量计量）：任意驱动 chat() 成功
 * 即落 ai_usage，业务调用方零感知。
 */
@Global()
@Module({})
export class LlmModule {
  static forRoot(): DynamicModule {
    return {
      module: LlmModule,
      global: true,
      providers: [
        {
          provide: LLM,
          inject: [ConfigService, DRIZZLE, TenantContextService],
          useFactory: (config: ConfigService, db: Database, tenantContext: TenantContextService): LLMClient => {
            const driver = config.getOrThrow<string>('LLM_DRIVER');
            let inner: LLMClient;
            switch (driver) {
              case 'memory':
                inner = new MemoryLlmAdapter();
                break;
              default:
                throw new Error(`未知 LLM 驱动 LLM_DRIVER=${driver}`);
            }
            return new UsageRecordingLlmClient(inner, db, tenantContext);
          },
        },
      ],
      exports: [LLM],
    };
  }
}
