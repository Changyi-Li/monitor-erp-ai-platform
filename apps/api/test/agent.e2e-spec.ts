import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  AgentConversationSchema,
  AgentConversationsResponseSchema,
  AgentMessagesResponseSchema,
  RagSyncsResponseSchema,
  type AgentCitation,
  type RagSync,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * 内部客服 AI Agent e2e（issue #22 验收）：
 * - ① 提问 → SSE 流式回答 + 引用角标 → citations → 点击跳转（documentId/URL 依据）
 * - ② 多轮对话记忆（checkpoint 持久化）+ 会话回看/继续
 * - ③ 检索范围后端注入（kb → internal，蓝图 → customer）；归属隔离（他人会话 404）
 * - ④ 权限：客户 403 / 未认证 401
 * 前置：发布 kb 文档（internal Index）+ 发布蓝图（customer Index）→ fake Index 双源就绪。
 */

/** SSE 帧解析（event:/data: 行，\n\n 分隔） */
function parseSseEvents(body: string): { event: string; data: string }[] {
  const events: { event: string; data: string }[] = [];
  for (const frame of body.split('\n\n')) {
    let event = '';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (frame.trim().length > 0) events.push({ event, data });
  }
  return events;
}

describe('Agent e2e：内部客服 AI', () => {
  let app: NestFastifyApplication;

  const password = 'password123';
  let internalToken: string;
  let otherInternalToken: string;
  let customerToken: string;
  let projectAId: string;
  let kbDocId: string; // 内部 Index 源（问「登录」命中）
  let blueprintId: string; // 客户 Index 源（问「订单」命中）

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

  async function createAndPublishKb(title: string, body: string): Promise<string> {
    const create = await app.inject({
      method: 'POST',
      url: '/api/kb/documents',
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { docType: 'markdown', title, category: 'faq', body },
    });
    expect(create.statusCode).toBe(201);
    const docId = (create.json() as { document: { id: string } }).document.id;
    const pub = await app.inject({
      method: 'POST',
      url: `/api/kb/documents/${docId}/publish`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(pub.statusCode).toBe(200);
    return docId;
  }

  /** 等 worker 把同步任务处理完（fake Index 就绪） */
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

  /** 提问 → SSE 流，返回事件序列 + 拼接的回答 + citations */
  async function ask(
    conversationId: string,
    content: string,
    token = internalToken,
  ): Promise<{ events: { event: string; data: string }[]; answer: string; citations: AgentCitation[] }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/agent/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = parseSseEvents(res.body as string);
    expect(events[0]?.event).toBe('citations');
    expect(events.at(-1)?.event).toBe('done');
    let answer = '';
    for (const e of events) {
      if (e.event === 'token') {
        answer += (JSON.parse(e.data) as { delta: string }).delta;
      }
    }
    const citations = (JSON.parse(events[0]!.data) as { citations: AgentCitation[] }).citations;
    return { events, answer, citations };
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
    const other = await register('other@corp.test');
    const customer = await register('customer@tenant-a.test');
    internalToken = internal.token;
    otherInternalToken = other.token;

    const owner = connectOwner();
    try {
      await owner`update users set role = 'customer_user' where id = ${customer.id}`;
      const [c] = await owner`insert into customers (name) values ('客户A') returning id`;
      await owner`insert into user_tenants (user_id, customer_id) values (${customer.id}, ${c.id})`;
      const project = await owner`insert into projects (tenant_id, name) values (${c.id}, 'P-A1') returning id`;
      projectAId = project[0].id as string;
      // 项目成员（蓝图创建需要）
      await owner`insert into project_members (project_id, user_id) values (${project[0].id}, ${internal.id})`;
    } finally {
      await owner.end();
    }
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'customer@tenant-a.test', password },
    });
    customerToken = (login.json() as { accessToken: string }).accessToken;

    // 检索源：kb（internal）+ 蓝图（customer）
    kbDocId = await createAndPublishKb('登录问题 FAQ', '无法登录时请检查账号与密码，然后重试。');
    await waitSyncSucceeded(kbDocId);

    const bp = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/blueprints`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: {
        drawio: {
          name: '订单流程.drawio',
          contentType: 'application/xml',
          base64: Buffer.from('<mxfile/>').toString('base64'),
        },
        moduleScope: '订单模块：创建、审核、发货流程。',
      },
    });
    expect(bp.statusCode).toBe(201);
    blueprintId = (bp.json() as { blueprint: { id: string } }).blueprint.id;
    await waitSyncSucceeded(blueprintId);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('验收 ①：提问 → 流式回答 + 引用角标（SSE）', () => {
    it('POST messages → text/event-stream，事件序 citations→token*→done，citations 指向 kb 文档', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/agent/conversations',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(create.statusCode).toBe(201);
      const conv = AgentConversationSchema.safeParse(create.json());
      expect(conv.success).toBe(true);

      const { events, answer, citations } = await ask(conv.data!.id, '如何登录？');
      // 事件序：citations 最先、done 最后、中间全是 token
      expect(events.every((e, i) => i === 0 || e.event === 'token' || e.event === 'done')).toBe(true);
      expect(events.filter((e) => e.event === 'token').length).toBeGreaterThan(0);
      // 回答拼接含确定性内容 + [1] 角标
      expect(answer).toContain('根据知识库「登录问题 FAQ」');
      expect(answer).toContain('[1]');
      // 引用溯源：documentId = kb 文档（点击跳转 /kb/{documentId}）
      expect(citations.length).toBe(1);
      expect(citations[0]).toMatchObject({
        index: 1,
        documentId: kbDocId,
        documentType: 'kb_document',
        projectId: null,
      });
      // done 事件携带完整消息
      const done = events.at(-1)!;
      const doneMessage = JSON.parse(done.data) as { message: { content: string; citations: AgentCitation[] } };
      expect(doneMessage.message.content).toBe(answer);
      expect(doneMessage.message.citations).toEqual(citations);
    });
  });

  describe('验收 ②：多轮记忆 + 会话回看/继续', () => {
    it('第二问「刚才的来源是什么？」→ 回答含第一轮问题（checkpoint 多轮记忆）', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/agent/conversations',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      const conv = (create.json() as { id: string });
      const first = await ask(conv.id, '如何重置密码？');
      expect(first.answer).toContain('根据知识库「登录问题 FAQ」');

      // 继续会话（同 thread_id）→ 历史注入 → memory LLM 复述上一问
      //（query 需含检索词——memory 驱动的追问分支要求本轮检索有命中）
      const second = await ask(conv.id, '登录问题的来源是什么？');
      expect(second.answer).toContain('上一轮您问的是「如何重置密码？」');
      expect(second.answer).toContain('登录问题 FAQ');

      // 会话列表含标题快照（首问前 20 字）
      const list = await app.inject({
        method: 'GET',
        url: '/api/agent/conversations',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(list.statusCode).toBe(200);
      const parsed = AgentConversationsResponseSchema.safeParse(list.json());
      expect(parsed.success).toBe(true);
      const mine = parsed.data!.conversations.find((c) => c.id === conv.id)!;
      expect(mine.title).toBe('如何重置密码？');

      // 回看：4 条消息（2 user + 2 assistant），assistant citations 非空
      const history = await app.inject({
        method: 'GET',
        url: `/api/agent/conversations/${conv.id}/messages`,
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(history.statusCode).toBe(200);
      const msgs = AgentMessagesResponseSchema.safeParse(history.json());
      expect(msgs.success).toBe(true);
      expect(msgs.data!.messages.map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      expect(msgs.data!.messages[1].citations.length).toBeGreaterThan(0);
    });
  });

  describe('验收 ③：检索范围后端注入（内部 KB + 所有客户 Index）', () => {
    it('问蓝图内容 → citations 含 blueprint + projectId（客户 Index 命中）', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/agent/conversations',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      const conv = create.json() as { id: string };
      const { answer, citations } = await ask(conv.id, '订单审核流程是怎样的？');
      expect(answer).toContain('根据知识库「订单流程.drawio」');
      expect(citations.some((c) => c.documentType === 'blueprint')).toBe(true);
      const bpCitation = citations.find((c) => c.documentType === 'blueprint')!;
      expect(bpCitation.documentId).toBe(blueprintId);
      expect(bpCitation.projectId).toBe(projectAId);
    });
  });

  describe('权限与认证', () => {
    it('客户用户访问 /agent/* → 403；未认证 → 401', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/agent/conversations',
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(create.statusCode).toBe(403);
      const list = await app.inject({
        method: 'GET',
        url: '/api/agent/conversations',
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(list.statusCode).toBe(403);
      const messages = await app.inject({
        method: 'GET',
        url: '/api/agent/conversations/some-id/messages',
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(messages.statusCode).toBe(403);
      const chat = await app.inject({
        method: 'POST',
        url: '/api/agent/conversations/some-id/messages',
        headers: { authorization: `Bearer ${customerToken}` },
        payload: { content: 'hi' },
      });
      expect(chat.statusCode).toBe(403);
      const noAuth = await app.inject({ method: 'GET', url: '/api/agent/conversations' });
      expect(noAuth.statusCode).toBe(401);
    });

    it('归属隔离：其他内部用户访问他人会话 → 404（含提问）', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/agent/conversations',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      const conv = create.json() as { id: string };
      const otherList = await app.inject({
        method: 'GET',
        url: `/api/agent/conversations/${conv.id}/messages`,
        headers: { authorization: `Bearer ${otherInternalToken}` },
      });
      expect(otherList.statusCode).toBe(404);
      const otherChat = await app.inject({
        method: 'POST',
        url: `/api/agent/conversations/${conv.id}/messages`,
        headers: { authorization: `Bearer ${otherInternalToken}` },
        payload: { content: '偷看' },
      });
      expect(otherChat.statusCode).toBe(404);
    });
  });
});
