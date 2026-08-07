import { LLM_SCENES, LLM_SCENE_LABELS, type LlmScene } from '@monitor/shared';
import type { LLMClient, LlmChatInput, LlmChatResult } from './llm-client.port';
import { MemoryLlmAdapter } from './memory-llm.adapter';
import { OpenaiLlmAdapter } from './openai-llm.adapter';

export type SceneDriverName = 'memory' | 'openai';

/** LLM 场景路由相关环境变量（pickSceneEnv 提取子集，纯函数可测） */
export interface SceneEnv {
  LLM_DRIVER?: string;
  LLM_DRIVER_AGENT?: string;
  LLM_DRIVER_DOCUMENT_PARSING?: string;
  LLM_DRIVER_MANUAL_GENERATION?: string;
  LLM_DRIVER_EMBEDDING?: string;
  LLM_OPENAI_BASE_URL?: string;
  LLM_OPENAI_API_KEY?: string;
  LLM_OPENAI_MODEL?: string;
}

/** 场景驱动配置来源（web 配置页展示兜底链路） */
export type SceneConfigSource = 'scene' | 'global' | 'default';

/** 单场景解析结果（契约 AiSceneConfig 的 API 侧映射源） */
export interface ResolvedSceneConfig {
  scene: LlmScene;
  label: string;
  driver: SceneDriverName;
  model: string;
  source: SceneConfigSource;
  enabled: boolean;
  reason?: string;
}

/** openai 驱动缺省值（显式配置优先；缺省值文档化在 ADR 0013） */
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'qwen-vl-max';

const DRIVER_ENV_KEY: Record<LlmScene, keyof SceneEnv> = {
  agent: 'LLM_DRIVER_AGENT',
  document_parsing: 'LLM_DRIVER_DOCUMENT_PARSING',
  manual_generation: 'LLM_DRIVER_MANUAL_GENERATION',
  embedding: 'LLM_DRIVER_EMBEDDING',
};

/**
 * 场景驱动解析纯函数：兜底链 = 场景专属 LLM_DRIVER_<SCENE> → 全局 LLM_DRIVER → 内置 memory。
 * source 标注配置来源；openai 驱动缺 API Key → enabled=false + reason（不抛错——
 * 配置表可展示，但 createDriver 构造该场景时抛错 fail-fast）。
 */
export function resolveSceneConfigs(env: SceneEnv): ResolvedSceneConfig[] {
  const globalDriver = env.LLM_DRIVER;
  return LLM_SCENES.map((scene) => {
    const label = LLM_SCENE_LABELS[scene];
    const sceneDriver = env[DRIVER_ENV_KEY[scene]];
    const driverName: SceneDriverName =
      sceneDriver === 'openai' || sceneDriver === 'memory'
        ? sceneDriver
        : globalDriver === 'openai' || globalDriver === 'memory'
          ? globalDriver
          : 'memory';
    const source: SceneConfigSource = sceneDriver ? 'scene' : globalDriver ? 'global' : 'default';

    let model: string;
    let enabled = true;
    let reason: string | undefined;
    if (driverName === 'memory') {
      model = 'memory';
    } else {
      model = env.LLM_OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
      if (!env.LLM_OPENAI_API_KEY) {
        enabled = false;
        reason = '缺少 LLM_OPENAI_API_KEY';
      }
    }
    return { scene, label, driver: driverName, model, source, enabled, reason };
  });
}

/**
 * 驱动实例工厂：构造 = 纯配置校验（零连接零网络），配置错误启动期 fail-fast。
 * openai 缺 API Key / 未知驱动名 → 抛错（带场景名）。
 */
export function createDriver(name: SceneDriverName, scene: LlmScene, env: SceneEnv): LLMClient {
  switch (name) {
    case 'memory':
      return new MemoryLlmAdapter();
    case 'openai': {
      const baseUrl = env.LLM_OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL;
      const model = env.LLM_OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
      if (!env.LLM_OPENAI_API_KEY) {
        throw new Error(`LLM openai 驱动配置不完整（场景 ${scene}）：缺少 LLM_OPENAI_API_KEY`);
      }
      return new OpenaiLlmAdapter({ baseUrl, apiKey: env.LLM_OPENAI_API_KEY, model });
    }
    default:
      throw new Error(`未知 LLM 驱动 driver=${name}（场景 ${scene}）`);
  }
}

/**
 * 场景路由 wrapper：按 context.scene 分发到该场景的驱动实例。
 * 每场景独立 driver 实例 = 运行时隔离（AC3：一个场景模型故障只冒泡给该场景调用方，
 * 不影响其他场景）；不做失败降级 memory（掩盖故障）。缺 scene / 未知 scene → 明确抛错。
 */
export class SceneRoutingLlmClient implements LLMClient {
  constructor(private readonly drivers: Record<LlmScene, LLMClient>) {}

  async chat(input: LlmChatInput): Promise<LlmChatResult> {
    if (!input.context?.scene) {
      throw new Error('LLM 调用必须标注 context.scene（AI 用量计量红线：缺场景无法计量）');
    }
    const driver = this.drivers[input.context.scene];
    if (!driver) {
      throw new Error(`未知 LLM 场景 scene=${input.context.scene}（支持：${LLM_SCENES.join('/')}）`);
    }
    return driver.chat(input);
  }
}
