import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  RagFailNextResponseSchema,
  RagIndexResponseSchema,
  RagSyncsResponseSchema,
  type RagSync,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * 文档 → RAG 同步 e2e（issue #21 验收）：
 * - ① 发布 kb 文档 → sync 行 queued → Worker 导入 → succeeded → fake Index（internal）可见
 * - ② 归档 → delete 任务 → Index 移除；恢复 → upsert 重置 → 重新导入（幂等键含 action，行不重复）
 * - ③ fail-next 注入 → 发布 → failed + 指数退避 → 自动重试 succeeded
 * - ④ scope 路由：kb → internal Index；蓝图发布 → customer Index（各归其位）
 * - 权限：客户 403 / 未认证 401（rag:view = 仅内部）
 * worker 事件驱动 + 2s 定时兜底，全部用 poll 等待（时间敏感）。
 */
describe('RAG e2e：发布即同步管线', () => {
  let app: NestFastifyApplication;

  const password = 'password123';
  let internalToken: string;
  let customerToken: string;
  let customerId: string;
  let projectAId: string;
  let kbDocId: string; // 验收①② 主文档（markdown）
  let kbDoc2Id: string; // 验收③ 失败重试文档
  let blueprintId: string; // 验收④ 客户 Index 源

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

  /** 轮询 syncs 直到谓词满足（worker 事件驱动 + 2s 定时兜底；失败重试场景放宽） */
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
    throw new Error('等待同步任务状态超时');
  }

  /** fake Index 可见性查询 */
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

  async function createAndPublishKb(title: string, body: string): Promise<string> {
    const create = await app.inject({
      method: 'POST',
      url: '/api/kb/documents',
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { docType: 'markdown', title, category: 'manual', body },
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
      await owner`update users set role = 'customer_user' where id = ${customer.id}`;
      const [c] = await owner`insert into customers (name) values ('客户A') returning id`;
      await owner`insert into user_tenants (user_id, customer_id) values (${customer.id}, ${c.id})`;
      customerId = c.id as string;
    } finally {
      await owner.end();
    }
    customerToken = await (async () => {
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'customer@tenant-a.test', password },
      });
      return (login.json() as { accessToken: string }).accessToken;
    })();

    // 项目（蓝图源）+ 验收① kb 文档
    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { tenantId: customerId, name: 'P-A1' },
    });
    expect(project.statusCode).toBe(201);
    projectAId = (project.json() as { project: { id: string } }).project.id;
    kbDocId = await createAndPublishKb('登录问题 FAQ', '# 登录失败排查');
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('验收 ①：发布 → 事件入队 → Worker 导入 → fake Index 可见', () => {
    it('发布 kb 文档 → sync 行 queued → succeeded（internal scope）→ Index 可见', async () => {
      const syncs = await waitSyncs((s) =>
        s.some((x) => x.documentId === kbDocId && x.action === 'upsert' && x.status === 'succeeded'),
      );
      const kbSync = syncs.find((x) => x.documentId === kbDocId && x.action === 'upsert')!;
      expect(kbSync.documentType).toBe('kb_document');
      expect(kbSync.scope).toBe('internal');
      expect(kbSync.versionNumber).toBe(1);
      expect(kbSync.title).toBe('登录问题 FAQ');

      const docs = await listIndex('internal');
      const hit = docs.find((d) => d.documentId === kbDocId);
      expect(hit?.versionNumber).toBe(1);
      expect(hit?.title).toBe('登录问题 FAQ');
    });
  });

  describe('验收 ②：归档删除 + 恢复重新导入（幂等键含 action）', () => {
    it('归档 → delete 任务 succeeded → Index 移除', async () => {
      const arch = await app.inject({
        method: 'POST',
        url: `/api/kb/documents/${kbDocId}/archive`,
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(arch.statusCode).toBe(200);
      await waitSyncs((s) =>
        s.some((x) => x.documentId === kbDocId && x.action === 'delete' && x.status === 'succeeded'),
      );
      expect((await listIndex('internal')).some((d) => d.documentId === kbDocId)).toBe(false);
    });

    it('恢复 → 同键 upsert 重置重新导入（不产生新行）→ Index 重新可见', async () => {
      const restore = await app.inject({
        method: 'POST',
        url: `/api/kb/documents/${kbDocId}/restore`,
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(restore.statusCode).toBe(200);
      await waitSyncs((s) => {
        const upserts = s.filter((x) => x.documentId === kbDocId && x.action === 'upsert');
        return upserts.length === 1 && upserts[0].status === 'succeeded';
      });
      const syncs = await waitSyncs((s) =>
        s.some((x) => x.documentId === kbDocId && x.action === 'delete' && x.status === 'succeeded'),
      );
      // 幂等键 (doc, type, version, action)：文档 A 只有 2 行（upsert v1 + delete v1），恢复不新增
      expect(syncs.filter((x) => x.documentId === kbDocId).length).toBe(2);
      const docs = await listIndex('internal');
      expect(docs.some((d) => d.documentId === kbDocId)).toBe(true);
    });
  });

  describe('验收 ③：同步失败自动重试（指数退避）', () => {
    it('fail-next 注入 → 发布 → failed（attempt≥1）→ 退避后自动重试 succeeded', async () => {
      const arm = await app.inject({
        method: 'POST',
        url: '/api/rag/debug/fail-next',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(arm.statusCode).toBe(200);
      expect(RagFailNextResponseSchema.safeParse(arm.json()).success).toBe(true);

      kbDoc2Id = await createAndPublishKb('失败重试文档', '第一次导入会失败');
      // 失败：attempt ≥ 1 + nextRetryAt 未来
      const failed = await waitSyncs((s) => {
        const x = s.find((y) => y.documentId === kbDoc2Id);
        return !!x && x.status === 'failed' && x.attempt >= 1;
      }, 8_000);
      const failedRow = failed.find((x) => x.documentId === kbDoc2Id)!;
      expect(failedRow.lastError).toContain('注入失败');
      // 指数退避自动重试（attempt=1 → 2s）→ succeeded（放宽 15s）
      await waitSyncs((s) => {
        const x = s.find((y) => y.documentId === kbDoc2Id);
        return !!x && x.status === 'succeeded' && x.attempt >= 1;
      }, 15_000);
      expect((await listIndex('internal')).some((d) => d.documentId === kbDoc2Id)).toBe(true);
    });
  });

  describe('验收 ④：scope 路由（内部/客户 Index 各归其位）', () => {
    it('蓝图发布 → customer scope 任务 → 客户 Index 可见，内部 Index 不含；kb 文档不在客户 Index', async () => {
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
          moduleScope: '订单/库存模块',
        },
      });
      expect(bp.statusCode).toBe(201);
      blueprintId = (bp.json() as { blueprint: { id: string } }).blueprint.id;
      await waitSyncs((s) =>
        s.some((x) => x.documentId === blueprintId && x.scope === 'customer' && x.status === 'succeeded'),
      );
      const sync = (await waitSyncs((s) => s.some((x) => x.documentId === blueprintId))).find(
        (x) => x.documentId === blueprintId,
      )!;
      expect(sync.documentType).toBe('blueprint');
      expect(sync.versionNumber).toBe(1);
      expect(sync.tenantId).toBe(customerId);

      const customerDocs = await listIndex('customer');
      const bpHit = customerDocs.find((d) => d.documentId === blueprintId);
      expect(bpHit?.title).toBe('订单流程.drawio');
      // 内部 kb 文档不在客户 Index；蓝图不在内部 Index（各归其位）
      expect(customerDocs.some((d) => d.documentId === kbDocId)).toBe(false);
      const internalDocs = await listIndex('internal');
      expect(internalDocs.some((d) => d.documentId === blueprintId)).toBe(false);
    });
  });

  describe('权限与认证', () => {
    it('客户用户访问 /rag/* → 403；未认证 → 401', async () => {
      const syncs = await app.inject({
        method: 'GET',
        url: '/api/rag/syncs',
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(syncs.statusCode).toBe(403);
      const index = await app.inject({
        method: 'GET',
        url: '/api/rag/index?scope=internal',
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(index.statusCode).toBe(403);
      const failNext = await app.inject({
        method: 'POST',
        url: '/api/rag/debug/fail-next',
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect(failNext.statusCode).toBe(403);
      const noAuth = await app.inject({ method: 'GET', url: '/api/rag/syncs' });
      expect(noAuth.statusCode).toBe(401);
    });
  });
});
