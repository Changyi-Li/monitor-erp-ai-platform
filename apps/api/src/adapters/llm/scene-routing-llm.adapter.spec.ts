import { describe, expect, it, vi } from 'vitest';
import {
  createDriver,
  resolveSceneConfigs,
  SceneRoutingLlmClient,
  type SceneEnv,
} from './scene-routing-llm.adapter';
import { MemoryLlmAdapter } from './memory-llm.adapter';
import { OpenaiLlmAdapter } from './openai-llm.adapter';
import type { LLMClient } from './llm-client.port';

/** 最小 env（无任何 LLM 变量） */
function baseEnv(overrides: Partial<SceneEnv> = {}): SceneEnv {
  return {
    LLM_DRIVER: undefined,
    LLM_DRIVER_AGENT: undefined,
    LLM_DRIVER_DOCUMENT_PARSING: undefined,
    LLM_DRIVER_MANUAL_GENERATION: undefined,
    LLM_DRIVER_EMBEDDING: undefined,
    LLM_OPENAI_BASE_URL: undefined,
    LLM_OPENAI_API_KEY: undefined,
    LLM_OPENAI_MODEL: undefined,
    ...overrides,
  };
}

describe('resolveSceneConfigs：场景驱动解析（兜底链）', () => {
  it('无任何配置 → 全部 memory / source=default / enabled', () => {
    const scenes = resolveSceneConfigs(baseEnv());
    expect(scenes).toHaveLength(4);
    expect(scenes.map((s) => s.scene)).toEqual(['agent', 'document_parsing', 'manual_generation', 'embedding']);
    for (const s of scenes) {
      expect(s.driver).toBe('memory');
      expect(s.model).toBe('memory');
      expect(s.source).toBe('default');
      expect(s.enabled).toBe(true);
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it('全局 LLM_DRIVER=openai（无 key）→ 各场景 driver=openai / source=global / 不可用 + reason', () => {
    const scenes = resolveSceneConfigs(baseEnv({ LLM_DRIVER: 'openai' }));
    for (const s of scenes) {
      expect(s.driver).toBe('openai');
      expect(s.source).toBe('global');
      expect(s.enabled).toBe(false);
      expect(s.reason).toContain('LLM_OPENAI_API_KEY');
    }
  });

  it('场景专属优先：仅 agent 场景配 openai（有 key）→ agent=openai/source=scene，其余回退 default memory', () => {
    const scenes = resolveSceneConfigs(
      baseEnv({ LLM_DRIVER_AGENT: 'openai', LLM_OPENAI_API_KEY: 'sk-test', LLM_OPENAI_MODEL: 'qwen-plus' }),
    );
    const agent = scenes.find((s) => s.scene === 'agent')!;
    expect(agent.driver).toBe('openai');
    expect(agent.source).toBe('scene');
    expect(agent.model).toBe('qwen-plus');
    expect(agent.enabled).toBe(true);
    const doc = scenes.find((s) => s.scene === 'document_parsing')!;
    expect(doc.driver).toBe('memory');
    expect(doc.source).toBe('default');
  });

  it('全局 openai + 场景专属 memory → 该场景 memory（场景优先于全局）', () => {
    const scenes = resolveSceneConfigs(
      baseEnv({ LLM_DRIVER: 'openai', LLM_DRIVER_DOCUMENT_PARSING: 'memory', LLM_OPENAI_API_KEY: 'sk-test' }),
    );
    expect(scenes.find((s) => s.scene === 'document_parsing')!.driver).toBe('memory');
    expect(scenes.find((s) => s.scene === 'agent')!.driver).toBe('openai');
  });

  it('openai 模型缺省 → qwen-vl-max（ADR 0013 缺省值）', () => {
    const scenes = resolveSceneConfigs(
      baseEnv({ LLM_DRIVER_AGENT: 'openai', LLM_OPENAI_API_KEY: 'sk-test' }),
    );
    expect(scenes.find((s) => s.scene === 'agent')!.model).toBe('qwen-vl-max');
  });
});

describe('createDriver：驱动实例工厂', () => {
  it('memory → MemoryLlmAdapter 实例', () => {
    expect(createDriver('memory', 'agent', baseEnv())).toBeInstanceOf(MemoryLlmAdapter);
  });

  it('openai（key 齐备）→ OpenaiLlmAdapter 实例', () => {
    const env = baseEnv({ LLM_OPENAI_API_KEY: 'sk-test', LLM_OPENAI_MODEL: 'qwen-vl-max' });
    expect(createDriver('openai', 'agent', env)).toBeInstanceOf(OpenaiLlmAdapter);
  });

  it('openai 缺 key → 构造抛错（启动期 fail-fast，带场景名）', () => {
    expect(() => createDriver('openai', 'document_parsing', baseEnv())).toThrow(/document_parsing/);
    expect(() => createDriver('openai', 'document_parsing', baseEnv())).toThrow(/LLM_OPENAI_API_KEY/);
  });

  it('未知驱动名 → 抛错', () => {
    expect(() => createDriver('unknown' as never, 'agent', baseEnv())).toThrow(/未知 LLM 驱动/);
  });
});

describe('SceneRoutingLlmClient：场景路由与隔离', () => {
  function makeDriver(name: string): LLMClient {
    return { chat: vi.fn().mockResolvedValue({ content: `${name} 回答`, usage: { model: name, inputTokens: 1, outputTokens: 1 } }) };
  }

  it('按 scene 分发到对应驱动实例', async () => {
    const agent = makeDriver('agent-driver');
    const doc = makeDriver('doc-driver');
    const client = new SceneRoutingLlmClient({
      agent,
      document_parsing: doc,
      manual_generation: makeDriver('mg'),
      embedding: makeDriver('emb'),
    });
    await client.chat({ messages: [], context: { scene: 'agent' } });
    await client.chat({ messages: [], context: { scene: 'document_parsing' } });
    expect(agent.chat).toHaveBeenCalledTimes(1);
    expect(doc.chat).toHaveBeenCalledTimes(1);
  });

  it('缺 scene → 抛错（计量红线）', async () => {
    const client = new SceneRoutingLlmClient({
      agent: makeDriver('a'),
      document_parsing: makeDriver('d'),
      manual_generation: makeDriver('m'),
      embedding: makeDriver('e'),
    });
    await expect(client.chat({ messages: [] })).rejects.toThrow(/context\.scene/);
  });

  it('未知 scene → 抛错', async () => {
    const client = new SceneRoutingLlmClient({
      agent: makeDriver('a'),
      document_parsing: makeDriver('d'),
      manual_generation: makeDriver('m'),
      embedding: makeDriver('e'),
    });
    await expect(client.chat({ messages: [], context: { scene: 'nope' as never } })).rejects.toThrow(/未知 LLM 场景/);
  });

  it('场景隔离：A 场景 driver 失败 → 只抛 A 的错误，B 场景正常（AC3）', async () => {
    const failing = { chat: vi.fn().mockRejectedValue(new Error('agent 模型故障')) };
    const ok = makeDriver('ok-driver');
    const client = new SceneRoutingLlmClient({
      agent: failing,
      document_parsing: ok,
      manual_generation: ok,
      embedding: ok,
    });
    await expect(client.chat({ messages: [], context: { scene: 'agent' } })).rejects.toThrow('agent 模型故障');
    const res = await client.chat({ messages: [], context: { scene: 'document_parsing' } });
    expect(res.content).toBe('ok-driver 回答');
  });
});
