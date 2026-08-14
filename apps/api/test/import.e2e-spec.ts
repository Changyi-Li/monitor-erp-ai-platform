import { createServer, type Server } from 'node:http';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  ImportFetchRunResponseSchema,
  ImportPushResponseSchema,
  ImportStagedListResponseSchema,
  RagIndexResponseSchema,
  RagSyncsResponseSchema,
  type ImportPushResponse,
  type ImportStaged,
  type RagSync,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * Online help 导入 e2e（issue #25 验收）：
 * ① API-key 推 markdown → 暂存 pending → Worker apply → kb 草稿（source=online_help）
 *    → 在线编辑 400 只读 → 发布 → #21 管线进内部 Index（AC1+AC3+AC4）
 * ② 去重：同内容重复推 duplicated + duplicateCount；变更 → 原地重置新草稿 → 发布 v2
 * ③ 删除：push delete → 硬删 + RAG delete → Index 移除
 * ④ 文件类推送 → 文件草稿 + content 下载字节一致
 * ⑤ 权限：无凭证/错 key 401；客户 JWT 403；内部 JWT 调试页通道可用
 * ⑥ 定时拉取：node:http mock 清单（env 注入须在 createTestingModule 之前）→
 *    POST /fetch/run → staged(source:'fetch') → 入库；清单变更 → 删除派生 + 变更派生；
 *    重复拉取 → duplicateCount 递增
 * ⑦ 删后回炉：delete 后同内容重推 → 重新创建（非误判重复）
 * 消费 worker 2s 轮询 + RAG worker 事件驱动，全部 poll 等待。
 */
describe('Import e2e：Online help 导入（issue #25）', () => {
  let app: NestFastifyApplication;
  let manifestServer: Server;
  let manifestItems: unknown[] = [];

  const password = 'password123';
  const API_KEY = 'test-import-key-0123456789abcdef';
  let internalToken: string;
  let customerToken: string;

  /** 清单 mock：返回当前 manifestItems（用例内可变，模拟外部源增量） */
  function startManifestServer(): Promise<string> {
    manifestServer = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(manifestItems));
    });
    return new Promise((resolve) => {
      manifestServer.listen(0, '127.0.0.1', () => {
        const addr = manifestServer.address();
        if (addr && typeof addr === 'object') {
          resolve(`http://127.0.0.1:${addr.port}/manifest`);
        }
      });
    });
  }

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

  /** 推送（x-api-key 外部通道 / Bearer JWT 调试页通道） */
  async function push(
    payload: unknown,
    opts: { key?: string; token?: string } = {},
  ): Promise<{ statusCode: number; body: unknown }> {
    const headers: Record<string, string> = {};
    if (opts.key !== undefined) {
      headers['x-api-key'] = opts.key;
    } else if (opts.token !== undefined) {
      headers.authorization = `Bearer ${opts.token}`;
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports/documents',
      headers,
      payload,
    });
    return { statusCode: res.statusCode, body: res.json() };
  }

  /** 暂存列表 */
  async function listStaged(): Promise<ImportStaged[]> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/imports/staged',
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(res.statusCode).toBe(200);
    const parsed = ImportStagedListResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return parsed.data!.records;
  }

  /** 轮询暂存直到谓词满足（消费 worker 2s 轮询） */
  async function waitStaged(
    predicate: (records: ImportStaged[]) => boolean,
    timeoutMs = 10_000,
  ): Promise<ImportStaged[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const records = await listStaged();
      if (predicate(records)) {
        return records;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('等待导入暂存状态超时');
  }

  /** 等待指定 staged 行 processed 并返回 documentId */
  async function waitApplied(sourceKey: string): Promise<string> {
    const records = await waitStaged((rs) => {
      const r = rs.find((x) => x.sourceKey === sourceKey && x.action === 'upsert');
      return !!r && r.status === 'processed' && r.documentId !== null;
    });
    // 列表按 createdAt 倒序——同 sourceKey 可能有多行（upsert/delete），必须按 action 过滤
    return records.find((x) => x.sourceKey === sourceKey && x.action === 'upsert')!.documentId!;
  }

  /** 轮询 RAG 同步任务直到谓词满足 */
  async function waitSyncs(
    predicate: (syncs: RagSync[]) => boolean,
    timeoutMs = 10_000,
  ): Promise<RagSync[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/rag/syncs',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(res.statusCode).toBe(200);
      const parsed = RagSyncsResponseSchema.safeParse(res.json());
      expect(parsed.success).toBe(true);
      if (predicate(parsed.data!.syncs)) {
        return parsed.data!.syncs;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('等待 RAG 同步任务状态超时');
  }

  /** fake Index 可见性 */
  async function listIndex(
    scope: 'internal' | 'customer',
  ): Promise<{ documentId: string; versionNumber: number; title: string }[]> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/rag/index?scope=${scope}`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(res.statusCode).toBe(200);
    const parsed = RagIndexResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return parsed.data!.documents;
  }

  /** kb 详情（内部） */
  async function kbGet(
    documentId: string,
  ): Promise<{ statusCode: number; body: { document?: Record<string, unknown> } }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/kb/documents/${documentId}`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    return { statusCode: res.statusCode, body: res.json() };
  }

  beforeAll(async () => {
    // 定时拉取 env 必须早于 createTestingModule（ConfigModule 在模块构建时校验/读取）；
    // 初始清单也须在 app.init 前赋值——worker 启动即跑会立即拉一次（异步追赶增量）
    process.env.IMPORT_FETCH_URL = await startManifestServer();
    process.env.IMPORT_FETCH_API_KEY = 'fetch-secret';
    process.env.IMPORT_FETCH_INTERVAL_MS = '60000';
    manifestItems = [
      { sourceKey: 'fetch/doc-a', title: '外部文档 A', category: 'manual', format: 'markdown', content: '# A v1' },
      { sourceKey: 'fetch/doc-b', title: '外部文档 B', category: 'faq', format: 'markdown', content: '# B' },
    ];

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
      await owner`update users set role = 'customer_user' where id = ${customer.id}`;
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
  });

  afterAll(async () => {
    delete process.env.IMPORT_FETCH_URL;
    delete process.env.IMPORT_FETCH_API_KEY;
    delete process.env.IMPORT_FETCH_INTERVAL_MS;
    await new Promise<void>((resolve) => manifestServer?.close(() => resolve()));
    await app?.close();
  });

  describe('验收 ①：API 推送 → 草稿 → 只读 → 人工发布 → 内部 Index（AC1+AC3+AC4）', () => {
    let docId: string;
    const sourceKey = 'help/login-issue';

    it('API-key 推 markdown → 201 pending → Worker → kb 草稿（source=online_help）', async () => {
      const res = await push(
        {
          action: 'upsert',
          sourceKey,
          docType: 'markdown',
          title: '登录问题 FAQ',
          category: 'faq',
          body: '# 登录失败排查\n1. 检查密码',
        },
        { key: API_KEY },
      );
      expect(res.statusCode).toBe(201);
      const parsed = ImportPushResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      const pushRes = parsed.data!;
      expect(pushRes.duplicated).toBe(false);
      expect(pushRes.record).toMatchObject({
        source: 'api',
        sourceKey,
        action: 'upsert',
        status: 'pending',
        docType: 'markdown',
        title: '登录问题 FAQ',
      });

      docId = await waitApplied(sourceKey);
      const kb = await kbGet(docId);
      expect(kb.statusCode).toBe(200);
      const doc = kb.body.document!;
      expect(doc.source).toBe('online_help');
      expect(doc.status).toBe('draft'); // 先落草稿待人工发布
      expect(doc.title).toBe('登录问题 FAQ');
      expect(doc.category).toBe('faq');
    });

    it('在线编辑 → 400 只读（AC3）；发布/归档入口保留', async () => {
      const edit = await app.inject({
        method: 'PATCH',
        url: `/api/kb/documents/${docId}`,
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { title: '篡改标题' },
      });
      expect(edit.statusCode).toBe(400);
      expect(String(edit.json().message)).toContain('只读');
    });

    it('人工发布 → #21 管线 upsert internal succeeded → Index 可见（AC4）', async () => {
      const pub = await app.inject({
        method: 'POST',
        url: `/api/kb/documents/${docId}/publish`,
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(pub.statusCode).toBe(200);
      const syncs = await waitSyncs((s) =>
        s.some((x) => x.documentId === docId && x.action === 'upsert' && x.status === 'succeeded'),
      );
      const sync = syncs.find((x) => x.documentId === docId)!;
      expect(sync.scope).toBe('internal');
      expect(sync.versionNumber).toBe(1);

      const docs = await listIndex('internal');
      const hit = docs.find((d) => d.documentId === docId);
      expect(hit?.versionNumber).toBe(1);
      expect(hit?.title).toBe('登录问题 FAQ');
    });
  });

  describe('验收 ②：重复推送去重 + 变更更新（AC2）', () => {
    const sourceKey = 'help/login-issue'; // 复用①文档

    it('同内容重复推 → duplicated:true + 行数不变 + duplicateCount=1', async () => {
      const before = await listStaged();
      const upsertRows = before.filter((x) => x.sourceKey === sourceKey && x.action === 'upsert');
      const beforeCount = upsertRows.length;
      const beforeId = upsertRows[0].id;
      const beforeDup = upsertRows[0].duplicateCount;

      const res = await push(
        {
          action: 'upsert',
          sourceKey,
          docType: 'markdown',
          title: '登录问题 FAQ',
          category: 'faq',
          body: '# 登录失败排查\n1. 检查密码',
        },
        { key: API_KEY },
      );
      expect(res.statusCode).toBe(201);
      const parsed = ImportPushResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.duplicated).toBe(true); // 同指纹判重，未重新入队
      expect(parsed.data!.record.id).toBe(beforeId);

      const after = await listStaged();
      const upsertAfter = after.filter((x) => x.sourceKey === sourceKey && x.action === 'upsert');
      expect(upsertAfter.length).toBe(beforeCount); // 幂等键防重行
      expect(upsertAfter[0].duplicateCount).toBe(beforeDup + 1);
    });

    it('变更内容重推 → 原地重置（行数不变）→ 新草稿 → 发布 v2 → Index 内容更新', async () => {
      const before = await listStaged();
      const beforeCount = before.filter((x) => x.sourceKey === sourceKey && x.action === 'upsert').length;

      const res = await push(
        {
          action: 'upsert',
          sourceKey,
          docType: 'markdown',
          title: '登录问题 FAQ v2',
          category: 'faq',
          body: '# 登录失败排查\n1. 检查密码\n2. 重置密码',
        },
        { key: API_KEY },
      );
      expect(res.statusCode).toBe(201);
      const parsed = ImportPushResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.duplicated).toBe(false); // 新指纹 → 变更

      const applied = await waitApplied(sourceKey);
      const after = await listStaged();
      const upsertAfter = after.filter((x) => x.sourceKey === sourceKey && x.action === 'upsert');
      expect(upsertAfter.length).toBe(beforeCount); // 原地重置，无新行
      expect(upsertAfter[0].attempt).toBe(0); // 重置语义：attempt 归零

      // 已发布文档的变更 → 新草稿（hasDraft）→ 人工发布 → v2 进 Index
      const kb = await kbGet(applied);
      expect((kb.body.document as Record<string, unknown>).hasDraft).toBe(true);
      const pub = await app.inject({
        method: 'POST',
        url: `/api/kb/documents/${applied}/publish`,
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(pub.statusCode).toBe(200);
      await waitSyncs((s) => {
        const x = s.find((y) => y.documentId === applied && y.action === 'upsert');
        return !!x && x.versionNumber === 2 && x.status === 'succeeded';
      });
      const docs = await listIndex('internal');
      const hit = docs.find((d) => d.documentId === applied);
      expect(hit?.versionNumber).toBe(2);
      expect(hit?.title).toBe('登录问题 FAQ v2'); // Index 内容更新
    });
  });

  describe('验收 ③：删除移除（硬删 + RAG 删除）', () => {
    const sourceKey = 'help/obsolete-guide';
    let docId: string;

    it('推送文档并发布 → Index 可见', async () => {
      const res = await push(
        {
          action: 'upsert',
          sourceKey,
          docType: 'markdown',
          title: '过时指南',
          category: 'manual',
          body: '即将废弃的内容',
        },
        { key: API_KEY },
      );
      expect(res.statusCode).toBe(201);
      docId = await waitApplied(sourceKey);
      const pub = await app.inject({
        method: 'POST',
        url: `/api/kb/documents/${docId}/publish`,
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(pub.statusCode).toBe(200);
      await waitSyncs((s) =>
        s.some((x) => x.documentId === docId && x.action === 'upsert' && x.status === 'succeeded'),
      );
      expect((await listIndex('internal')).some((d) => d.documentId === docId)).toBe(true);
    });

    it('推 delete → Worker 硬删（GET 404）+ RAG delete succeeded → Index 移除', async () => {
      const res = await push({ action: 'delete', sourceKey }, { key: API_KEY });
      expect(res.statusCode).toBe(201);
      expect(ImportPushResponseSchema.safeParse(res.body).success).toBe(true);

      await waitStaged((rs) => {
        const r = rs.find((x) => x.sourceKey === sourceKey && x.action === 'delete');
        return !!r && r.status === 'processed';
      });
      expect((await kbGet(docId)).statusCode).toBe(404); // 硬删除
      await waitSyncs((s) =>
        s.some((x) => x.documentId === docId && x.action === 'delete' && x.status === 'succeeded'),
      );
      expect((await listIndex('internal')).some((d) => d.documentId === docId)).toBe(false);
    });
  });

  describe('验收 ④：文件类推送', () => {
    const sourceKey = 'help/manual-pdf';
    const rawBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<fake pdf>>');
    let docId: string;

    it('base64 推送 → 文件草稿（只读）+ content 下载字节一致', async () => {
      const res = await push(
        {
          action: 'upsert',
          sourceKey,
          docType: 'file',
          title: '操作手册 PDF',
          category: 'manual',
          fileName: 'manual.pdf',
          contentType: 'application/pdf',
          base64: rawBytes.toString('base64'),
        },
        { key: API_KEY },
      );
      expect(res.statusCode).toBe(201);
      docId = await waitApplied(sourceKey);
      const kb = await kbGet(docId);
      const doc = kb.body.document!;
      expect(doc.docType).toBe('file');
      expect(doc.source).toBe('online_help');
      expect((doc.file as { name: string }).name).toBe('manual.pdf');

      const content = await app.inject({
        method: 'GET',
        url: `/api/kb/documents/${docId}/content`,
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(content.statusCode).toBe(200);
      expect(Buffer.from(content.rawPayload)).toEqual(rawBytes);
    });
  });

  describe('验收 ⑤：权限与认证', () => {
    it('无凭证 / 错误 API key → 401；客户 JWT → 403；内部 JWT 调试页通道可用', async () => {
      const payload = {
        action: 'upsert',
        sourceKey: 'help/permission-check',
        docType: 'markdown',
        title: '权限',
        category: 'manual',
        body: 'x',
      };
      const noAuth = await push(payload);
      expect(noAuth.statusCode).toBe(401);
      const wrongKey = await push(payload, { key: 'wrong-key-0123456789' });
      expect(wrongKey.statusCode).toBe(401);
      const customerPush = await push(payload, { token: customerToken });
      expect(customerPush.statusCode).toBe(403);

      const staged = await app.inject({
        method: 'GET',
        url: '/api/imports/staged',
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(staged.statusCode).toBe(403);
      const fetchRun = await app.inject({
        method: 'POST',
        url: '/api/imports/fetch/run',
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(fetchRun.statusCode).toBe(403);

      const internalPush = await push(payload, { token: internalToken });
      expect(internalPush.statusCode).toBe(201); // 调试页通道（JWT）与 API-key 等价
      await waitApplied('help/permission-check');
    });
  });

  describe('验收 ⑥：定时拉取（HTTP 清单 → 暂存 → 入库；变更派生 + 删除派生）', () => {
    it('启动即拉（worker 初始化，beforeAll 已赋初始清单）→ fetch 文档入库', async () => {
      // 等初始拉取（启动即跑）消费完
      await waitStaged((rs) => {
        const rows = rs.filter((x) => x.source === 'fetch' && x.action === 'upsert');
        return rows.length === 2 && rows.every((r) => r.status === 'processed');
      });
      for (const key of ['fetch/doc-a', 'fetch/doc-b']) {
        const id = await waitApplied(key);
        const kb = await kbGet(id);
        expect(kb.body.document!.source).toBe('online_help');
      }
    });

    it('重复拉取同清单 → staged 0 + duplicateCount 递增（去重记录可见）', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/imports/fetch/run',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(res.statusCode).toBe(200);
      const parsed = ImportFetchRunResponseSchema.safeParse(res.json());
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual({ fetched: 2, staged: 0, deleted: 0 }); // 全重复
      const records = await listStaged();
      const a = records.find((r) => r.sourceKey === 'fetch/doc-a' && r.action === 'upsert')!;
      expect(a.duplicateCount).toBeGreaterThanOrEqual(1);
    });

    it('清单变更（改 A + 删 B）→ 变更派生（staged=1）+ 删除派生（deleted=1）', async () => {
      // 先人工发布 A v1（导入只落草稿；hasDraft 仅对已发布文档有意义）；
      // 记下 B 的 id——删除派生行不填 documentId（applyDelete 按 externalKey 反查）
      const prevId = await waitApplied('fetch/doc-a');
      const bId = await waitApplied('fetch/doc-b');
      const pub = await app.inject({
        method: 'POST',
        url: `/api/kb/documents/${prevId}/publish`,
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(pub.statusCode).toBe(200);

      manifestItems = [
        { sourceKey: 'fetch/doc-a', title: '外部文档 A v2', category: 'manual', format: 'markdown', content: '# A v2 内容' },
      ];
      const res = await app.inject({
        method: 'POST',
        url: '/api/imports/fetch/run',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(res.statusCode).toBe(200);
      const parsed = ImportFetchRunResponseSchema.safeParse(res.json());
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual({ fetched: 1, staged: 1, deleted: 1 });

      // 变更：A 产生新草稿（已发布后 hasDraft）→ B 被硬删
      const aId = await waitApplied('fetch/doc-a');
      const a = await kbGet(aId);
      expect((a.body.document as Record<string, unknown>).hasDraft).toBe(true);
      await waitStaged((rs) => {
        const del = rs.find((x) => x.sourceKey === 'fetch/doc-b' && x.action === 'delete');
        return !!del && del.status === 'processed';
      });
      expect((await kbGet(bId)).statusCode).toBe(404); // B 已硬删
    });
  });

  describe('验收 ⑦：删后回炉（delete 后同内容重推 → 重新创建，非误判重复）', () => {
    it('同内容重推 → duplicated:false + 新文档（id 不同）', async () => {
      const sourceKey = 'help/resurrect-doc';
      const payload = {
        action: 'upsert' as const,
        sourceKey,
        docType: 'markdown' as const,
        title: '复活文档',
        category: 'manual',
        body: '删除后又回来的内容',
      };
      await push(payload, { key: API_KEY });
      const firstId = await waitApplied(sourceKey);
      await push({ action: 'delete', sourceKey }, { key: API_KEY });
      await waitStaged((rs) => {
        const r = rs.find((x) => x.sourceKey === sourceKey && x.action === 'delete');
        return !!r && r.status === 'processed';
      });
      expect((await kbGet(firstId)).statusCode).toBe(404);

      // 同内容重推：指纹相同但 kb 文档不存在 → reset 语义（非 duplicate）
      const res = await push(payload, { key: API_KEY });
      expect(res.statusCode).toBe(201);
      const parsed = ImportPushResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.duplicated).toBe(false);

      const secondId = await waitApplied(sourceKey);
      expect(secondId).not.toBe(firstId); // 新文档，非复活旧行
      const kb = await kbGet(secondId);
      expect(kb.statusCode).toBe(200);
      expect(kb.body.document!.status).toBe('draft');
    });
  });
});
