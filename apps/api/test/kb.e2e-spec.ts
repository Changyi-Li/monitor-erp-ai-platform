import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  KbContentResponseSchema,
  KbDocumentResponseSchema,
  KbListResponseSchema,
  KbVersionsResponseSchema,
  RagSyncsResponseSchema,
  type KbDocumentDetail,
  type KbVersion,
  type RagSync,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

// 与 main.ts 一致的请求体上限（8MB base64 超限测试需要穿过 Fastify 层到达 zod 校验）
const BODY_LIMIT = 10_000_000;

/**
 * 内部知识库 e2e（issue #19 验收；知识库为**全局域**——不挂客户/项目，无租户隔离）：
 * - ① Markdown 编辑保存草稿 → 发布（版本化）
 * - ② 文件类上传（Word/PDF 等 base64 通道）→ 分类管理（筛选）
 * - ③ 编辑已发布 → 派生新草稿版本（线上不动）→ 重新发布 → 归档/恢复（列表消失/重现）
 * - ④ 客户用户只读已发布（含另一客户——全局共享语义）；草稿/归档 404；写操作 403；未登录 401
 * - 审计：kb.create/update/publish/archive/restore 落 audit_logs
 */
describe('KB e2e：内部知识库', () => {
  let app: NestFastifyApplication;

  const password = 'password123';

  let internalToken: string;
  let customerAToken: string; // 客户 A（与内部用户同逻辑视图）
  let customerBToken: string; // 客户 B（另一租户——知识库全局，同样可读已发布）

  let markdownDocId: string;
  let fileDocId: string;

  async function register(email: string): Promise<{ id: string; token: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password, displayName: email.split('@')[0] },
    });
    expect(res.statusCode).toBe(201);
    const { user } = res.json() as { user: { id: string } };
    return { id: user.id, token: await login(email) };
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { accessToken: string }).accessToken;
  }

  async function createDoc(
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; document: KbDocumentDetail | null }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kb/documents',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    if (res.statusCode !== 201) {
      return { status: res.statusCode, document: null };
    }
    const parsed = KbDocumentResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, document: parsed.data!.document };
  }

  async function listDocs(
    token: string,
    query = '',
  ): Promise<{ status: number; documents: KbDocumentDetail[] }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/kb/documents${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.statusCode !== 200) {
      return { status: res.statusCode, documents: [] };
    }
    const parsed = KbListResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, documents: parsed.data!.documents };
  }

  async function getDoc(
    token: string,
    documentId: string,
  ): Promise<{ status: number; document: KbDocumentDetail | null }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/kb/documents/${documentId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.statusCode !== 200) {
      return { status: res.statusCode, document: null };
    }
    const parsed = KbDocumentResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, document: parsed.data!.document };
  }

  async function patchDoc(
    token: string,
    documentId: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; document: KbDocumentDetail | null }> {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/kb/documents/${documentId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    if (res.statusCode !== 200) {
      return { status: res.statusCode, document: null };
    }
    const parsed = KbDocumentResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, document: parsed.data!.document };
  }

  async function actionDoc(
    action: 'publish' | 'archive' | 'restore',
    token: string,
    documentId: string,
  ): Promise<{ status: number; document: KbDocumentDetail | null }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/kb/documents/${documentId}/${action}`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.statusCode !== 200) {
      return { status: res.statusCode, document: null };
    }
    const parsed = KbDocumentResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, document: parsed.data!.document };
  }

  async function versions(
    token: string,
    documentId: string,
  ): Promise<{ status: number; versions: KbVersion[] }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/kb/documents/${documentId}/versions`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.statusCode !== 200) {
      return { status: res.statusCode, versions: [] };
    }
    const parsed = KbVersionsResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, versions: parsed.data!.versions };
  }

  beforeAll(async () => {
    await resetTestDb();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ bodyLimit: BODY_LIMIT }),
    );
    app.setGlobalPrefix('api');
    await app.init();

    const internal = await register('internal@corp.test');
    const customerA = await register('customer-a@tenant-a.test');
    const customerB = await register('customer-b@tenant-b.test');
    internalToken = internal.token;

    // 知识库全局域：客户用户只需 role=customer（+ 各归其租户），无需项目成员
    const owner = connectOwner();
    try {
      await owner`update users set role = 'customer' where id = ${customerA.id}`;
      await owner`update users set role = 'customer' where id = ${customerB.id}`;
      const [customerRowA] = await owner`insert into customers (name) values ('客户A') returning id`;
      const [customerRowB] = await owner`insert into customers (name) values ('客户B') returning id`;
      await owner`insert into user_tenants (user_id, customer_id) values (${customerA.id}, ${customerRowA.id})`;
      await owner`insert into user_tenants (user_id, customer_id) values (${customerB.id}, ${customerRowB.id})`;
    } finally {
      await owner.end();
    }
    // 改 role 后重新登录（JWT 内 role 以登录时 DB 值为准；同 minutes e2e 模式）
    customerAToken = await login('customer-a@tenant-a.test');
    customerBToken = await login('customer-b@tenant-b.test');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('验收①-1：创建 markdown 草稿 → 列表（内部可见草稿）→ 保存草稿', async () => {
    const created = await createDoc(internalToken, {
      docType: 'markdown',
      title: '标准操作手册：库存盘点',
      category: 'manual',
      body: '# 库存盘点流程\n\n1. 月末结账后盘点\n2. 差异录入系统',
    });
    expect(created.status).toBe(201);
    const doc = created.document!;
    expect(doc.status).toBe('draft');
    expect(doc.category).toBe('manual');
    expect(doc.docType).toBe('markdown');
    expect(doc.body).toContain('库存盘点流程');
    expect(doc.hasDraft).toBe(false);
    expect(doc.createdBy?.displayName).toBeTruthy();
    markdownDocId = doc.id;

    const list = await listDocs(internalToken);
    expect(list.status).toBe(200);
    expect(list.documents.map((d) => d.id)).toContain(markdownDocId);

    // 保存草稿：改正文 + 改标题
    const saved = await patchDoc(internalToken, markdownDocId, {
      title: '标准操作手册：库存盘点（v2 草稿）',
      body: '# 库存盘点流程（更新）\n\n1. 每日差异快照',
    });
    expect(saved.status).toBe(200);
    expect(saved.document!.title).toBe('标准操作手册：库存盘点（v2 草稿）');
    expect(saved.document!.body).toContain('每日差异快照');

    // 校验失败：标题缺失 400 / 坏分类 400 / 坏 uuid 404
    const noTitle = await app.inject({
      method: 'POST',
      url: '/api/kb/documents',
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { docType: 'markdown', category: 'manual' },
    });
    expect(noTitle.statusCode).toBe(400);
    const badCategory = await app.inject({
      method: 'POST',
      url: '/api/kb/documents',
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { docType: 'markdown', title: 'x', category: 'wiki' },
    });
    expect(badCategory.statusCode).toBe(400);
    const notFound = await app.inject({
      method: 'GET',
      url: '/api/kb/documents/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(notFound.statusCode).toBe(404);
  });

  it('验收①-2：发布 → 已发布 + 版本 1（快照同步标题/分类）→ 客户可见', async () => {
    const published = await actionDoc('publish', internalToken, markdownDocId);
    expect(published.status).toBe(200);
    const doc = published.document!;
    expect(doc.status).toBe('published');
    expect(doc.hasDraft).toBe(false);
    expect(doc.title).toBe('标准操作手册：库存盘点（v2 草稿）'); // 快照写回文档头
    expect(doc.body).toContain('每日差异快照');

    // 已发布 + 无草稿 → publish 400
    const republish = await actionDoc('publish', internalToken, markdownDocId);
    expect(republish.status).toBe(400);

    const customerList = await listDocs(customerAToken);
    expect(customerList.status).toBe(200);
    expect(customerList.documents.map((d) => d.id)).toContain(markdownDocId);
    const customerGet = await getDoc(customerAToken, markdownDocId);
    expect(customerGet.status).toBe(200);
    expect(customerGet.document!.viewerRole).toBe('customer');
    expect(customerGet.document!.body).toContain('每日差异快照');
  });

  it('验收②：上传文件类文档 → 分类筛选 → 下载（字节一致 + RFC 5987）', async () => {
    const pdfBuffer = Buffer.from('%PDF-1.4\nhello kb file content');
    const created = await createDoc(internalToken, {
      docType: 'file',
      title: '项目验收清单',
      category: 'faq',
      fileName: '验收清单.pdf',
      contentType: 'application/pdf',
      base64: pdfBuffer.toString('base64'),
    });
    expect(created.status).toBe(201);
    const doc = created.document!;
    expect(doc.docType).toBe('file');
    expect(doc.file).toMatchObject({ name: '验收清单.pdf', size: pdfBuffer.byteLength }); // size 实测
    fileDocId = doc.id;

    // 分类筛选（草稿态内部可见；category=manual 不含它，category=faq 含它）
    const byManual = await listDocs(internalToken, '?category=manual');
    expect(byManual.documents.map((d) => d.id)).toContain(markdownDocId);
    expect(byManual.documents.map((d) => d.id)).not.toContain(fileDocId);
    const byFaq = await listDocs(internalToken, '?category=faq');
    expect(byFaq.documents.map((d) => d.id)).toContain(fileDocId);

    // 保存草稿：改分类（草稿态直接生效）
    const recat = await patchDoc(internalToken, fileDocId, { category: 'best_practice' });
    expect(recat.status).toBe(200);
    expect(recat.document!.category).toBe('best_practice');

    // 文件类当前内容下载（草稿态 = 草稿文件）
    const file = await app.inject({
      method: 'GET',
      url: `/api/kb/documents/${fileDocId}/content`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent('验收清单.pdf')}`,
    );
    expect(file.rawPayload.toString('utf8')).toBe('%PDF-1.4\nhello kb file content');

    // 坏 uuid 404
    const missing = await app.inject({
      method: 'GET',
      url: '/api/kb/documents/00000000-0000-0000-0000-000000000000/content',
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('验收③-1：编辑已发布 → 派生新草稿版本（线上不动）→ 重新发布（版本 2）', async () => {
    const before = await getDoc(internalToken, markdownDocId);
    expect(before.document!.body).toContain('每日差异快照');

    const edited = await patchDoc(internalToken, markdownDocId, {
      body: '# 库存盘点流程（第三次修订）',
    });
    expect(edited.status).toBe(200);
    expect(edited.document!.hasDraft).toBe(true); // 有待发布草稿
    expect(edited.document!.body).toContain('每日差异快照'); // 详情仍显示线上内容（重新发布才生效）
    expect(edited.document!.title).toBe('标准操作手册：库存盘点（v2 草稿）');

    // 版本历史：v1（已发布）+ 草稿版本
    const hist = await versions(internalToken, markdownDocId);
    expect(hist.status).toBe(200);
    expect(hist.versions).toHaveLength(2);
    const v1 = hist.versions.find((v) => v.versionNumber === 1)!;
    expect(v1.publishedBy?.displayName).toBeTruthy();
    expect(v1.publishedAt).toBeTruthy();
    const draft = hist.versions.find((v) => v.versionNumber === null)!;
    expect(draft.body).toContain('第三次修订');

    // 版本内容回看（markdown → {body}）
    const v1Content = await app.inject({
      method: 'GET',
      url: `/api/kb/documents/${markdownDocId}/versions/${v1.id}/content`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(v1Content.statusCode).toBe(200);
    expect(KbContentResponseSchema.safeParse(v1Content.json()).success).toBe(true);
    expect((v1Content.json() as { body: string }).body).toContain('每日差异快照');

    // 重新发布 → 版本 2 + 线上更新 + hasDraft 清除
    const republished = await actionDoc('publish', internalToken, markdownDocId);
    expect(republished.status).toBe(200);
    expect(republished.document!.hasDraft).toBe(false);
    expect(republished.document!.body).toContain('第三次修订');
    const hist2 = await versions(internalToken, markdownDocId);
    expect(hist2.versions.filter((v) => v.versionNumber !== null)).toHaveLength(2);
  });

  it('验收③-2：归档（列表消失/客户 404）→ includeArchived 可见 → 恢复', async () => {
    // 归档前客户可读
    const customerGet = await getDoc(customerAToken, markdownDocId);
    expect(customerGet.status).toBe(200);

    const archived = await actionDoc('archive', internalToken, markdownDocId);
    expect(archived.status).toBe(200);
    expect(archived.document!.status).toBe('archived');

    // 内部默认列表不含归档（「归档即下架」）；客户读 → 404（RLS）
    const internalList = await listDocs(internalToken);
    expect(internalList.documents.map((d) => d.id)).not.toContain(markdownDocId);
    const customerAfter = await getDoc(customerAToken, markdownDocId);
    expect(customerAfter.status).toBe(404);
    const customerList = await listDocs(customerAToken);
    expect(customerList.documents.map((d) => d.id)).not.toContain(markdownDocId);

    // includeArchived 管理视图可见
    const withArchived = await listDocs(internalToken, '?includeArchived=true');
    expect(withArchived.documents.map((d) => d.id)).toContain(markdownDocId);

    // 归档文档不可编辑（先恢复）
    const editArchived = await patchDoc(internalToken, markdownDocId, { body: 'x' });
    expect(editArchived.status).toBe(400);
    const publishArchived = await actionDoc('publish', internalToken, markdownDocId);
    expect(publishArchived.status).toBe(400);

    // 恢复 → 重新上架，客户可读，线上内容 = 最后发布版本
    const restored = await actionDoc('restore', internalToken, markdownDocId);
    expect(restored.status).toBe(200);
    expect(restored.document!.status).toBe('published');
    expect(restored.document!.body).toContain('第三次修订');
    const customerRestored = await getDoc(customerAToken, markdownDocId);
    expect(customerRestored.status).toBe(200);

    // 非归档不可恢复 / 草稿不可归档
    const restoreAgain = await actionDoc('restore', internalToken, markdownDocId);
    expect(restoreAgain.status).toBe(400);
    const archiveDraft = await actionDoc('archive', internalToken, fileDocId);
    expect(archiveDraft.status).toBe(400);
  });

  it('验收④：客户只读（含另一客户——全局共享）；写操作 403；未登录 401', async () => {
    // 客户 A / 客户 B 均可读已发布文档（知识库全局，无租户隔离）
    for (const token of [customerAToken, customerBToken]) {
      const list = await listDocs(token);
      expect(list.status).toBe(200);
      expect(list.documents.map((d) => d.id)).toContain(markdownDocId);
      const detail = await getDoc(token, markdownDocId);
      expect(detail.status).toBe(200);
      expect(detail.document!.viewerRole).toBe('customer');
    }

    // 客户读草稿文档 → 404（RLS 挡）
    const draftForCustomer = await getDoc(customerAToken, fileDocId);
    expect(draftForCustomer.status).toBe(404);

    // 客户写操作全 403
    for (const [method, url, payload] of [
      ['POST', '/api/kb/documents', { docType: 'markdown', title: 'x', category: 'manual' }],
      ['PATCH', `/api/kb/documents/${markdownDocId}`, { body: 'x' }],
      ['POST', `/api/kb/documents/${markdownDocId}/publish`, undefined],
      ['POST', `/api/kb/documents/${markdownDocId}/archive`, undefined],
      ['POST', `/api/kb/documents/${markdownDocId}/restore`, undefined],
      ['GET', `/api/kb/documents/${markdownDocId}/versions`, undefined],
      ['GET', `/api/kb/documents/${markdownDocId}/versions/${markdownDocId}/content`, undefined],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${customerAToken}` },
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode, `${method} ${url} 应 403`).toBe(403);
    }

    // 未登录 401
    const noAuth = await app.inject({ method: 'GET', url: '/api/kb/documents' });
    expect(noAuth.statusCode).toBe(401);

    // 文件下载客户可用（已发布后）
    await actionDoc('publish', internalToken, fileDocId);
    const customerFile = await app.inject({
      method: 'GET',
      url: `/api/kb/documents/${fileDocId}/content`,
      headers: { authorization: `Bearer ${customerAToken}` },
    });
    expect(customerFile.statusCode).toBe(200);
    expect(customerFile.rawPayload.toString('utf8')).toBe('%PDF-1.4\nhello kb file content');
  });

  it('验收④：文件类覆盖上传（编辑已发布 → 派生草稿 → 重新发布生效）+ base64 超限 400', async () => {
    const newPdf = Buffer.from('%PDF-2.0 replaced content');
    const overWritten = await patchDoc(internalToken, fileDocId, {
      fileName: '验收清单-v2.pdf',
      contentType: 'application/pdf',
      base64: newPdf.toString('base64'),
    });
    expect(overWritten.status).toBe(200);
    expect(overWritten.document!.hasDraft).toBe(true);
    expect(overWritten.document!.file!.name).toBe('验收清单.pdf'); // 线上仍是旧文件（重新发布才生效）

    const published = await actionDoc('publish', internalToken, fileDocId);
    expect(published.status).toBe(200);
    expect(published.document!.file!.name).toBe('验收清单-v2.pdf');
    expect(published.document!.file!.size).toBe(newPdf.byteLength);

    const download = await app.inject({
      method: 'GET',
      url: `/api/kb/documents/${fileDocId}/content`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.toString('utf8')).toBe('%PDF-2.0 replaced content');

    // base64 超限 400（>8,000,000 字符 → 契约拦截）
    const tooBig = await createDoc(internalToken, {
      docType: 'file',
      title: 'x',
      category: 'manual',
      fileName: 'big.pdf',
      contentType: 'application/pdf',
      base64: 'a'.repeat(8_000_001),
    });
    expect(tooBig.status).toBe(400);
  });

  it('审计：kb.create/update/publish/archive/restore 落 audit_logs（含 metadata）', async () => {
    const owner = connectOwner();
    try {
      for (const action of ['kb.create', 'kb.update', 'kb.publish', 'kb.archive', 'kb.restore']) {
        const rows = await owner`select metadata from audit_logs where action = ${action}`;
        expect(rows.length, `${action} 应至少 1 条`).toBeGreaterThanOrEqual(1);
        const metadata = JSON.parse(rows[0].metadata as string) as Record<string, unknown>;
        expect(metadata.title).toBeTruthy();
      }
      const publishMeta = JSON.parse(
        (await owner`select metadata from audit_logs where action = 'kb.publish' order by created_at desc limit 1`)
          .map((r) => r.metadata as string)[0],
      ) as Record<string, unknown>;
      expect(publishMeta.toVersion).toBeGreaterThanOrEqual(1);
    } finally {
      await owner.end();
    }
  });

  it('回归（issue #26）：全局文档发布 → sync scope 仍 internal（tenant_id NULL 分支不变）', async () => {
    // markdownDocId 已在验收①-2 发布；等 worker 消费后断言 scope 路由不受项目挂靠影响
    const deadline = Date.now() + 10_000;
    let syncs: RagSync[] = [];
    while (Date.now() < deadline) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/rag/syncs',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(res.statusCode).toBe(200);
      const parsed = RagSyncsResponseSchema.safeParse(res.json());
      expect(parsed.success).toBe(true);
      syncs = parsed.data!.syncs;
      const hit = syncs.find(
        (x) => x.documentId === markdownDocId && x.action === 'upsert' && x.status === 'succeeded',
      );
      if (hit) {
        expect(hit.documentType).toBe('kb_document');
        expect(hit.scope).toBe('internal'); // 无 projectId → internal，不进入客户 Index
        expect(hit.tenantId).toBeNull();
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('等待全局文档同步超时');
  });
});
