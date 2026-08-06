import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  AgentConversationSchema,
  RagSyncsResponseSchema,
  UsageSummaryResponseSchema,
  UsageTrendResponseSchema,
  type RagSync,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * AI Token 用量计量 e2e（issue #23 验收）：
 * - ① 每次 LLM 调用（agent 提问）产生用量记录：summary 计数/token 随调用增长、
 *   scene=agent / model=memory 标注、客户/项目归属为「未归属」（agent 客服无绑定）
 * - ② 统计视图维度：按场景/模型分组 + day 趋势桶 + from/to 时间筛选
 * - ③ 权限：客户 403 / 未认证 401（内部专属）
 * 前置：发布 kb 文档（检索命中 → memory LLM 正常回答路径）。
 */

describe('Usage e2e：AI Token 用量计量', () => {
  let app: NestFastifyApplication;

  const password = 'password123';
  let internalToken: string;
  let customerToken: string;
  let kbDocId: string;

  async function register(email: string): Promise<{ id: string; token: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password, displayName: email.split('@')[0] },
    });
    expect(res.statusCode).toBe(201);
    const { user } = res.json() as { user: { id: string } };
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(login.statusCode).toBe(200);
    return { id: user.id, token: (login.json() as { accessToken: string }).accessToken };
  }

  /** 提问（SSE 响应完整缓冲，无需逐帧消费——计量发生在请求事务内、流开始前） */
  async function ask(conversationId: string, content: string): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/agent/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { content },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
  }

  /** 每次断言都重新抓取（禁止复用旧响应——数据随调用增长） */
  async function fetchSummary(params = ''): Promise<ReturnType<typeof UsageSummaryResponseSchema.parse>> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/usage/summary${params}`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(res.statusCode).toBe(200);
    const parsed = UsageSummaryResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true); // 契约 safeParse
    return parsed.data!;
  }

  async function fetchTrend(params = ''): Promise<ReturnType<typeof UsageTrendResponseSchema.parse>> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/usage/trend${params}`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(res.statusCode).toBe(200);
    const parsed = UsageTrendResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return parsed.data!;
  }

  async function waitSyncSucceeded(documentId: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/rag/syncs',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      const parsed = RagSyncsResponseSchema.safeParse(res.json());
      const syncs = parsed.success ? (parsed.data!.syncs as RagSync[]) : [];
      if (
        syncs.some(
          (x) =>
            x.documentId === documentId &&
            x.action === 'upsert' &&
            x.status === 'succeeded',
        )
      ) {
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('等待同步任务 succeeded 超时');
  }

  beforeAll(async () => {
    await resetTestDb();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();

    const internal = await register('internal@corp.test');
    const customer = await register('customer@tenant-a.test');
    internalToken = internal.token;

    const owner = connectOwner();
    try {
      await owner`update users set role = 'customer' where id = ${customer.id}`;
      const [c] = await owner`insert into customers (name) values ('客户A') returning id`;
      await owner`insert into user_tenants (user_id, customer_id) values (${customer.id}, ${c.id})`;
    } finally {
      await owner.end();
    }
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'customer@tenant-a.test', password },
    });
    customerToken = (login.json() as { accessToken: string }).accessToken;

    // 检索源（提问 → memory LLM 正常回答路径）
    const create = await app.inject({
      method: 'POST',
      url: '/api/kb/documents',
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { docType: 'markdown', title: '登录问题 FAQ', category: 'faq', body: '无法登录时请检查账号与密码，然后重试。' },
    });
    expect(create.statusCode).toBe(201);
    kbDocId = (create.json() as { document: { id: string } }).document.id;
    const pub = await app.inject({
      method: 'POST',
      url: `/api/kb/documents/${kbDocId}/publish`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(pub.statusCode).toBe(200);
    await waitSyncSucceeded(kbDocId);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('验收 ①：每次 LLM 调用产生用量记录（归属与场景标注）', () => {
    it('提问 1 次 → summary 计数=1、scene=agent、model=memory、客户/项目未归属', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/agent/conversations',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(create.statusCode).toBe(201);
      const conv = AgentConversationSchema.safeParse(create.json());
      expect(conv.success).toBe(true);
      await ask(conv.data!.id, '如何登录？');

      const summary = await fetchSummary();
      expect(summary.total.calls).toBe(1);
      expect(summary.total.inputTokens).toBeGreaterThan(0);
      expect(summary.total.outputTokens).toBeGreaterThan(0);
      expect(summary.total.totalCostUsd).toBeNull(); // fake 阶段无真实单价（预留字段）

      const agentScene = summary.byScene.find((x) => x.key === 'agent');
      expect(agentScene).toMatchObject({ key: 'agent', name: 'agent', calls: 1 });
      const memoryModel = summary.byModel.find((x) => x.key === 'memory');
      expect(memoryModel).toMatchObject({ key: 'memory', name: 'memory', calls: 1 });
      // agent 客服无项目/客户绑定 → 「未归属」组
      expect(summary.byCustomer).toEqual([
        expect.objectContaining({ key: null, name: '未归属', calls: 1 }),
      ]);
      expect(summary.byProject).toEqual([
        expect.objectContaining({ key: null, name: '未归属', calls: 1 }),
      ]);
    });

    it('再提问 2 次（同会话多轮）→ 计数=3、每维分组同步增长', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/agent/conversations',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      const conv = create.json() as { id: string };
      await ask(conv.id, '如何登录？'); // 会话首问（无历史注入）
      await ask(conv.id, '登录问题的来源是什么？'); // 同会话多轮（历史注入）

      const summary = await fetchSummary();
      expect(summary.total.calls).toBe(3);
      expect(summary.total.inputTokens).toBeGreaterThan(0);
      expect(summary.byScene.find((x) => x.key === 'agent')!.calls).toBe(3);
      expect(summary.byModel.find((x) => x.key === 'memory')!.calls).toBe(3);
      expect(summary.byCustomer.find((x) => x.key === null)!.calls).toBe(3);
    });
  });

  describe('验收 ②：维度汇总与趋势（时间桶 + 筛选）', () => {
    it('trend granularity=day → 今日桶 calls 与总量一致', async () => {
      const trend = await fetchTrend();
      expect(trend.points.length).toBeGreaterThanOrEqual(1);
      const today = trend.points.at(-1)!;
      expect(today.calls).toBeGreaterThanOrEqual(3);
      expect(today.inputTokens).toBeGreaterThan(0);
      // bucket 为 ISO datetime（z.iso.datetime 已由 safeParse 保证）
      expect(new Date(today.bucket).toISOString()).toBe(today.bucket);
    });

    it('from/to 筛选排除范围外记录（from=未来 → 0）', async () => {
      const future = await fetchSummary('?from=2099-01-01T00%3A00%3A00.000Z');
      expect(future.total.calls).toBe(0);
      expect(future.byScene).toEqual([]);
      const past = await fetchSummary('?to=2000-01-01T00%3A00%3A00.000Z');
      expect(past.total.calls).toBe(0);
    });

    it('scene/model 筛选 + 非法枚举 → 400', async () => {
      const agentOnly = await fetchSummary('?scene=agent');
      expect(agentOnly.total.calls).toBe(3);
      const bad = await app.inject({
        method: 'GET',
        url: '/api/usage/summary?scene=manual',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe('权限与认证（内部专属）', () => {
    it('客户用户访问 summary/trend → 403；未认证 → 401', async () => {
      for (const url of ['/api/usage/summary', '/api/usage/trend']) {
        const forbidden = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${customerToken}` },
        });
        expect(forbidden.statusCode).toBe(403);
        const noAuth = await app.inject({ method: 'GET', url });
        expect(noAuth.statusCode).toBe(401);
      }
    });
  });
});
