import { describe, expect, it, vi } from 'vitest';
import { aiUsage } from '../../database/schema';
import type { TenantContextService } from '../../database/tenant-context.service';
import type { Database } from '../../database/database.types';
import { UsageRecordingLlmClient } from './usage-recording-llm.adapter';
import type { LLMClient } from './llm-client.port';

/**
 * usage-recording wrapper 单测（issue #23）：mock DRIZZLE 断言 insert 参数；
 * 真实落库（请求事务 + RLS）由 usage.e2e-spec.ts 覆盖（仓库约定：DB 行为一律走 e2e）。
 */
describe('usage-recording LLM wrapper：统一计量', () => {
  function makeInner(): LLMClient {
    return {
      chat: vi.fn().mockResolvedValue({
        content: '根据知识库「登录问题 FAQ」：…[1]。',
        usage: { model: 'memory', inputTokens: 100, outputTokens: 25 },
      }),
    };
  }

  function makeDb() {
    const values = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockReturnValue({ values });
    return { insert, values, db: { insert } as unknown as Database };
  }

  function makeClient(db: Database, userId?: string) {
    const tenantContext = { current: userId ? { userId, tenantId: null, isInternal: true } : null };
    return new UsageRecordingLlmClient(makeInner(), db, tenantContext as unknown as TenantContextService);
  }

  it('chat 成功后落 ai_usage（场景/归属/token/发起者全字段）', async () => {
    const { insert, values, db } = makeDb();
    const client = makeClient(db, 'u-123');

    const result = await client.chat({
      messages: [{ role: 'user', content: '如何登录？' }],
      context: { scene: 'agent', conversationId: 'c-456' },
    });

    expect(result.content).toContain('登录问题 FAQ'); // 透传 driver 结果
    expect(insert).toHaveBeenCalledWith(aiUsage);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        scene: 'agent',
        model: 'memory',
        inputTokens: 100,
        outputTokens: 25,
        customerId: null,
        projectId: null,
        userId: 'u-123', // 发起者来自 ALS tenantContext
        conversationId: 'c-456',
      }),
    );
  });

  it('客户/项目归属透传（未来场景填充）', async () => {
    const { values, db } = makeDb();
    const client = makeClient(db, 'u-123');
    await client.chat({
      messages: [{ role: 'user', content: 'x' }],
      context: { scene: 'manual_generation', customerId: 'cu-1', projectId: 'pr-1' },
    });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ scene: 'manual_generation', customerId: 'cu-1', projectId: 'pr-1' }),
    );
  });

  it('无 ALS 上下文（后台任务）→ userId 兜底 system', async () => {
    const { values, db } = makeDb();
    const client = makeClient(db);
    await client.chat({
      messages: [{ role: 'user', content: 'x' }],
      context: { scene: 'embedding' },
    });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ userId: 'system' }));
  });

  it('缺 scene 抛错（防漏标导致无法按场景计量）', async () => {
    const { db } = makeDb();
    const client = makeClient(db, 'u-123');
    await expect(
      client.chat({ messages: [{ role: 'user', content: 'x' }], context: { conversationId: 'c-1' } }),
    ).rejects.toThrow('context.scene');
  });

  it('driver 调用失败 → 不落库（异常透传）', async () => {
    const inner: LLMClient = {
      chat: vi.fn().mockRejectedValue(new Error('LLM 服务不可用')),
    };
    const { insert, db } = makeDb();
    const tenantContext = { current: { userId: 'u-123', tenantId: null, isInternal: true } };
    const client = new UsageRecordingLlmClient(inner, db, tenantContext as unknown as TenantContextService);
    await expect(
      client.chat({
        messages: [{ role: 'user', content: 'x' }],
        context: { scene: 'agent' },
      }),
    ).rejects.toThrow('LLM 服务不可用');
    expect(insert).not.toHaveBeenCalled();
  });
});
