import { Global, Module, type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MemoryLlmAdapter } from './memory-llm.adapter';
import type { LLMClient } from './llm-client.port';

export const LLM = Symbol('LLM');

/** LLM 门面适配工厂：切换真实供应商 = 改 LLM_DRIVER 配置，业务代码零改动（切片 13/14 接入） */
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
          inject: [ConfigService],
          useFactory: (config: ConfigService): LLMClient => {
            const driver = config.getOrThrow<string>('LLM_DRIVER');
            switch (driver) {
              case 'memory':
                return new MemoryLlmAdapter();
              default:
                throw new Error(`未知 LLM 驱动 LLM_DRIVER=${driver}`);
            }
          },
        },
      ],
      exports: [LLM],
    };
  }
}
