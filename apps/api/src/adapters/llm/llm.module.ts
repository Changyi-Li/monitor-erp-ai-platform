import { Global, Module, type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LlmScene } from '@monitor/shared';
import { DRIZZLE, type Database } from '../../database/database.module';
import { TenantContextService } from '../../database/tenant-context.service';
import type { LLMClient } from './llm-client.port';
import {
  createDriver,
  resolveSceneConfigs,
  SceneRoutingLlmClient,
  type ResolvedSceneConfig,
} from './scene-routing-llm.adapter';
import { UsageRecordingLlmClient } from './usage-recording-llm.adapter';

export const LLM = Symbol('LLM');
/** 运行时场景配置（/api/ai/config 数据源，与 LLM 工厂同一次解析——单一事实来源） */
export const LLM_RUNTIME_CONFIG = Symbol('LLM_RUNTIME_CONFIG');

/** LLM 场景路由相关 env 子集（同 resolveSceneConfigs/createDriver 的 SceneEnv 键） */
function pickSceneEnv(config: ConfigService): Record<string, string | undefined> {
  return {
    LLM_DRIVER: config.get<string>('LLM_DRIVER'),
    LLM_DRIVER_AGENT: config.get<string>('LLM_DRIVER_AGENT'),
    LLM_DRIVER_DOCUMENT_PARSING: config.get<string>('LLM_DRIVER_DOCUMENT_PARSING'),
    LLM_DRIVER_MANUAL_GENERATION: config.get<string>('LLM_DRIVER_MANUAL_GENERATION'),
    LLM_DRIVER_EMBEDDING: config.get<string>('LLM_DRIVER_EMBEDDING'),
    LLM_OPENAI_BASE_URL: config.get<string>('LLM_OPENAI_BASE_URL'),
    LLM_OPENAI_API_KEY: config.get<string>('LLM_OPENAI_API_KEY'),
    LLM_OPENAI_MODEL: config.get<string>('LLM_OPENAI_MODEL'),
  };
}

/**
 * LLM 门面适配工厂（issue #24 场景化多模型路由）：按场景配置驱动（LLM_DRIVER_<SCENE>
 * 回退 LLM_DRIVER），每场景独立驱动实例 = 运行时隔离（一个场景模型故障不影响其他场景）；
 * 配置错误（未知驱动/缺 API Key）启动期全量构造 fail-fast。嵌套顺序：
 * UsageRecording( SceneRouting( drivers ) )——路由后 usage 记录实际模型。
 * 外层 UsageRecordingLlmClient（issue #23）：任意驱动 chat() 成功即落 ai_usage，业务调用方零感知。
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
            const env = pickSceneEnv(config);
            const drivers = Object.fromEntries(
              resolveSceneConfigs(env).map((c) => [c.scene, createDriver(c.driver, c.scene, env)]),
            ) as Record<LlmScene, LLMClient>;
            return new UsageRecordingLlmClient(new SceneRoutingLlmClient(drivers), db, tenantContext);
          },
        },
        {
          provide: LLM_RUNTIME_CONFIG,
          inject: [ConfigService],
          useFactory: (config: ConfigService): ResolvedSceneConfig[] =>
            resolveSceneConfigs(pickSceneEnv(config)),
        },
      ],
      exports: [LLM, LLM_RUNTIME_CONFIG],
    };
  }
}
