import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  BlueprintPublishResponseSchema,
  BlueprintVersionsListResponseSchema,
  KbDocumentResponseSchema,
  KbListResponseSchema,
  ManualAssembleResponseSchema,
  ManualChapterResponseSchema,
  ManualGenerationDetailResponseSchema,
  ManualGenerationsListResponseSchema,
  MemberInviteResponseSchema,
  RagIndexResponseSchema,
  RagSyncsResponseSchema,
  SetPasswordResponseSchema,
  type RagSync,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * 操作手册自动生成 e2e（issue #26 验收）：
 * - ① 内部选蓝图版本（真实 drawio 流程）→ 章节大纲 → 5 章 pending（AC1）
 * - ② 逐章生成（进度回显蓝图流程行）→ 审校保存（edited）→ 重新生成覆盖（AC2）
 * - ③ 组装（目录）→ 发布 → kb 草稿（category=manual/挂项目）→ kb 发布 →
 *    customer scope 同步 → 客户 Index 可见（AC3）
 * - ④ 蓝图发布 v2 → 列表 stale + currentVersion=2；v1 会话内容不被覆盖（AC4）
 * - ⑤ 同租户客户可见（kb 租户过滤）；异租户 404；客户维护操作 403（AC5）
 * - 审计：manual.create/chapter_generate/chapter_update/assemble/publish 落库
 */
describe('Manual e2e：操作手册自动生成', () => {
  let app: NestFastifyApplication;

  const password = 'password123';

  /** 真实 draw.io 形态：swimlane 容器 + 顶点 + HTML 实体 + 边（可解析出流程） */
  const DRAWIO_FIXTURE = `<mxfile>
  <diagram id="page1" name="Page-1">
    <mxGraphModel>
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="2" value="订单处理" style="swimlane;horizontal=1;" vertex="1" parent="1">
          <mxGeometry x="20" y="20" width="560" height="320" as="geometry" />
        </mxCell>
        <mxCell id="3" value="接收订单" style="rounded=1;" vertex="1" parent="2">
          <mxGeometry x="40" y="40" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="4" value="审核&amp;确认" vertex="1" parent="2">
          <mxGeometry x="40" y="140" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="5" value="&lt;b&gt;发货&lt;/b&gt;&lt;br&gt;含装箱单" vertex="1" parent="2">
          <mxGeometry x="200" y="40" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="6" value="库存不足" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="2" source="3" target="4">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

  let internalToken: string;
  let keyUserToken: string; // 同租户项目成员（客户视角：可看不可写）
  let outsiderToken: string; // 同租户非成员
  let crossTenantToken: string; // 另一客户（跨租户 → 404 防探测）
  let projectAId: string;
  let blueprintId: string;
  let customerAId: string;
  let generationId: string;
  let kbDocId: string;

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

  async function inviteMember(projectId: string, email: string, role: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { email, role },
    });
    expect(res.statusCode).toBe(201);
    const inviteUrl = MemberInviteResponseSchema.parse(res.json()).inviteUrl!;
    const token = new URL(inviteUrl).searchParams.get('token')!;
    const setPw = await app.inject({
      method: 'POST',
      url: '/api/auth/set-password',
      payload: { token, password },
    });
    expect(setPw.statusCode).toBe(200);
    expect(SetPasswordResponseSchema.safeParse(setPw.json()).success).toBe(true);
    return login(email);
  }

  function drawioUpload(xml: string) {
    return {
      name: '蓝图.drawio',
      contentType: 'application/xml',
      base64: Buffer.from(xml, 'utf8').toString('base64'),
    };
  }

  async function createBlueprint(): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/blueprints`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: {
        drawio: drawioUpload(DRAWIO_FIXTURE),
        businessRequirements: '订单处理自动化',
        moduleScope: '订单/库存模块',
      },
    });
    expect(res.statusCode).toBe(201);
    const parsed = BlueprintPublishResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    blueprintId = parsed.data!.blueprint.id;
  }

  /** 发布蓝图新版本（v2：换流程文件 + 字段） */
  async function publishBlueprintV2(): Promise<void> {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectAId}/blueprints`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { drawio: drawioUpload(DRAWIO_FIXTURE.replace('接收订单', '接收订单（v2 直连 WMS）')) },
    });
    expect(patch.statusCode).toBe(200);
    const pub = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/blueprints/publish`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(pub.statusCode).toBe(200);
    expect(BlueprintPublishResponseSchema.parse(pub.json()).version.version).toBe(2);
  }

  /** 轮询 syncs 直到谓词满足（worker 事件驱动 + 300ms 轮询兜底） */
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

  beforeAll(async () => {
    await resetTestDb();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();

    const internal = await register('internal@corp.test');
    const outsider = await register('outsider@tenant-a.test');
    const crossTenant = await register('cross@tenant-b.test');
    internalToken = internal.token;

    const owner = connectOwner();
    try {
      await owner`update users set role = 'customer' where id = ${outsider.id}`;
      await owner`update users set role = 'customer' where id = ${crossTenant.id}`;
      const [customerA] = await owner`insert into customers (name) values ('客户A') returning id`;
      const [customerB] = await owner`insert into customers (name) values ('客户B') returning id`;
      await owner`insert into user_tenants (user_id, customer_id) values (${outsider.id}, ${customerA.id})`;
      await owner`insert into user_tenants (user_id, customer_id) values (${crossTenant.id}, ${customerB.id})`;
      customerAId = customerA.id as string;
      const [projectA] = await owner`
        insert into projects (tenant_id, name) values (${customerAId}, 'P-A1') returning id`;
      projectAId = projectA.id as string;
    } finally {
      await owner.end();
    }
    outsiderToken = await login('outsider@tenant-a.test');
    crossTenantToken = await login('cross@tenant-b.test');
    keyUserToken = await inviteMember(projectAId, 'ku@tenant-a.test', 'key_user');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('AC1：内部创建蓝图（drawio 流程）→ 生成会话 → 5 章 pending 大纲', async () => {
    await createBlueprint();

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/manuals`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { blueprintVersion: 1 },
    });
    expect(res.statusCode).toBe(201);
    const parsed = ManualGenerationDetailResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    const generation = parsed.data!.generation;
    expect(generation.blueprintVersion).toBe(1);
    expect(generation.blueprintId).toBe(blueprintId);
    expect(generation.status).toBe('in_progress');
    expect(generation.stale).toBe(false);
    expect(generation.title).toBe('蓝图.drawio 操作手册 v1'); // 默认标题 = 流程图名 + 版本
    expect(generation.chapterCount).toBe(5);
    expect(generation.chapters).toHaveLength(5);
    // memory fake 确定性大纲 5 章，全部 pending（正文未生成）
    expect(generation.chapters.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(generation.chapters.every((c) => c.status === 'pending')).toBe(true);
    expect(generation.chapters.every((c) => c.outline !== null)).toBe(true);
    // 大纲内嵌蓝图流程行（drawio 解析 → LLM 上下文）
    expect(generation.chapters[0]!.outline).toContain('接收订单');
    generationId = generation.id;
  });

  it('契约与边界：版本 0 → 400；不存在版本 → 404；客户创建 → 403；非成员 403；跨租户 404', async () => {
    const badVersion = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/manuals`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { blueprintVersion: 0 },
    });
    expect(badVersion.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/manuals`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { blueprintVersion: 99 },
    });
    expect(missing.statusCode).toBe(404);

    const byCustomer = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/manuals`,
      headers: { authorization: `Bearer ${keyUserToken}` },
      payload: { blueprintVersion: 1 },
    });
    expect(byCustomer.statusCode).toBe(403);
    // 非成员 403（列表）；跨租户 404（列表）
    const byOutsider = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/manuals`,
      headers: { authorization: `Bearer ${outsiderToken}` },
    });
    expect(byOutsider.statusCode).toBe(403);
    const byCross = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/manuals`,
      headers: { authorization: `Bearer ${crossTenantToken}` },
    });
    expect(byCross.statusCode).toBe(404);
  });

  it('AC2：逐章生成（回显蓝图流程行）→ 审校保存 edited → 重新生成覆盖', async () => {
    const chapterIds: string[] = [];
    for (let seq = 1; seq <= 5; seq++) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/manuals/${generationId}`,
        headers: { authorization: `Bearer ${internalToken}` },
      });
      const chapter = ManualGenerationDetailResponseSchema.parse(res.json()).generation.chapters.find(
        (c) => c.seq === seq,
      )!;
      chapterIds.push(chapter.id);
      const gen = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectAId}/manuals/${generationId}/chapters/${chapter.id}/generate`,
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(gen.statusCode).toBe(200);
      const parsed = ManualChapterResponseSchema.safeParse(gen.json());
      expect(parsed.success).toBe(true);
      expect(parsed.data!.chapter.status).toBe('ready');
      expect(parsed.data!.chapter.contentMd).toContain('## ');
      expect(parsed.data!.chapter.aiGeneratedAt).toBeTruthy();
      if (seq === 1) {
        // 流程行回显：drawio 解析的「接收订单」步骤进入正文
        expect(parsed.data!.chapter.contentMd).toContain('接收订单');
      }
    }

    // 审校保存（PUT）→ edited + editedAt
    const humanized = '# 第一章 修订\n\n人工审校内容。';
    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectAId}/manuals/${generationId}/chapters/${chapterIds[0]}`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { contentMd: humanized },
    });
    expect(put.statusCode).toBe(200);
    expect(ManualChapterResponseSchema.parse(put.json()).chapter.status).toBe('edited');
    expect(ManualChapterResponseSchema.parse(put.json()).chapter.editedAt).toBeTruthy();

    // 重新生成 → ready + 覆盖人工内容（回到 AI 生成态）
    const regen = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/manuals/${generationId}/chapters/${chapterIds[0]}/generate`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(regen.statusCode).toBe(200);
    const regenChapter = ManualChapterResponseSchema.parse(regen.json()).chapter;
    expect(regenChapter.status).toBe('ready');
    expect(regenChapter.contentMd).not.toContain('人工审校内容');
    expect(regenChapter.contentMd).toContain('接收订单');
  });

  it('AC3：组装（目录）→ 发布落 kb 草稿（挂项目）→ kb 发布 → 客户 Index 可见', async () => {
    // 组装预览（整本 Markdown）
    const asm = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/manuals/${generationId}/assemble`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(asm.statusCode).toBe(200);
    const asmParsed = ManualAssembleResponseSchema.safeParse(asm.json());
    expect(asmParsed.success).toBe(true);
    expect(asmParsed.data!.body).toContain('# 蓝图.drawio 操作手册 v1');
    expect(asmParsed.data!.body).toContain('> 项目：P-A1｜客户：客户A｜蓝图版本：v1');
    expect(asmParsed.data!.body).toContain('## 目录');
    expect(asmParsed.data!.body).toContain('- 1. 系统概述与登录'); // 目录锚点
    expect(asmParsed.data!.body).toContain('## 1. 系统概述与登录'); // 章节正文
    expect(asmParsed.data!.body).toContain('## 5. 附录');

    // 发布 → 落项目 kb 草稿（不自动发布 kb 草稿）
    const pub = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/manuals/${generationId}/publish`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(pub.statusCode).toBe(200);
    const pubParsed = ManualGenerationDetailResponseSchema.safeParse(pub.json());
    expect(pubParsed.success).toBe(true);
    expect(pubParsed.data!.generation.status).toBe('published');
    kbDocId = pubParsed.data!.generation.kbDocumentId!;
    expect(kbDocId).toBeTruthy();

    // kb 草稿：category=manual + 挂项目/租户 + 草稿态
    const kb = await app.inject({
      method: 'GET',
      url: `/api/kb/documents/${kbDocId}`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(kb.statusCode).toBe(200);
    const kbParsed = KbDocumentResponseSchema.safeParse(kb.json());
    expect(kbParsed.success).toBe(true);
    expect(kbParsed.data!.document.category).toBe('manual');
    expect(kbParsed.data!.document.projectId).toBe(projectAId);
    expect(kbParsed.data!.document.status).toBe('draft');

    // 用户在 kb 详情页发布 → customer scope 同步（scope 路由 = projectId ? customer : internal）
    const kbPub = await app.inject({
      method: 'POST',
      url: `/api/kb/documents/${kbDocId}/publish`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(kbPub.statusCode).toBe(200);
    const syncs = await waitSyncs((s) =>
      s.some((x) => x.documentId === kbDocId && x.action === 'upsert' && x.status === 'succeeded'),
    );
    const sync = syncs.find((x) => x.documentId === kbDocId && x.action === 'upsert')!;
    expect(sync.documentType).toBe('kb_document');
    expect(sync.scope).toBe('customer');
    expect(sync.tenantId).toBe(customerAId);
    expect(sync.versionNumber).toBe(1);

    // 客户 Index 可见（fake Index 按 scope 分桶）
    const index = await app.inject({
      method: 'GET',
      url: '/api/rag/index?scope=customer',
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(index.statusCode).toBe(200);
    const idxParsed = RagIndexResponseSchema.safeParse(index.json());
    expect(idxParsed.success).toBe(true);
    const hit = idxParsed.data!.documents.find((d) => d.documentId === kbDocId);
    expect(hit?.title).toBe('蓝图.drawio 操作手册 v1');
  });

  it('AC4：蓝图发布 v2 → 列表 stale=true + currentVersion=2；v1 会话内容不被覆盖', async () => {
    await publishBlueprintV2();

    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/manuals`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(list.statusCode).toBe(200);
    const listParsed = ManualGenerationsListResponseSchema.safeParse(list.json());
    expect(listParsed.success).toBe(true);
    const row = listParsed.data!.generations.find((g) => g.id === generationId)!;
    expect(row.stale).toBe(true); // 读时计算：蓝图 max(version)=2 > 生成时 1
    expect(row.currentBlueprintVersion).toBe(2);

    // v1 会话内容未被覆盖（章节正文仍是 v1 流程回显）
    const detail = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/manuals/${generationId}`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(detail.statusCode).toBe(200);
    const detailParsed = ManualGenerationDetailResponseSchema.safeParse(detail.json());
    expect(detailParsed.success).toBe(true);
    expect(detailParsed.data!.generation.chapters[0]!.contentMd).toContain('接收订单');
    expect(detailParsed.data!.generation.chapters[0]!.contentMd).not.toContain('v2 直连 WMS');
  });

  it('AC5：同租户客户可见（kb 租户过滤）；异租户 404；客户维护操作 403', async () => {
    // 同租户项目成员：kb 列表含手册 + 详情 200（RLS 租户过滤，非项目级——项目无关客户用户也能看）
    const byMember = await app.inject({
      method: 'GET',
      url: '/api/kb/documents',
      headers: { authorization: `Bearer ${keyUserToken}` },
    });
    expect(byMember.statusCode).toBe(200);
    const memberList = KbListResponseSchema.parse(byMember.json()).documents;
    expect(memberList.map((d) => d.id)).toContain(kbDocId);
    expect(memberList.find((d) => d.id === kbDocId)!.projectId).toBe(projectAId);

    const memberDetail = await app.inject({
      method: 'GET',
      url: `/api/kb/documents/${kbDocId}`,
      headers: { authorization: `Bearer ${keyUserToken}` },
    });
    expect(memberDetail.statusCode).toBe(200);
    expect(KbDocumentResponseSchema.parse(memberDetail.json()).document.body).toContain('## 目录');

    // 异租户客户：列表不含 + 详情 404（tenant_id 过滤/RLS）
    const byCross = await app.inject({
      method: 'GET',
      url: '/api/kb/documents',
      headers: { authorization: `Bearer ${crossTenantToken}` },
    });
    expect(byCross.statusCode).toBe(200);
    const crossList = KbListResponseSchema.parse(byCross.json()).documents;
    expect(crossList.map((d) => d.id)).not.toContain(kbDocId);
    const crossDetail = await app.inject({
      method: 'GET',
      url: `/api/kb/documents/${kbDocId}`,
      headers: { authorization: `Bearer ${crossTenantToken}` },
    });
    expect(crossDetail.statusCode).toBe(404);

    // 客户维护操作 403：章节生成 / 组装 / 发布 / 审校
    const gen = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/manuals/${generationId}/chapters/00000000-0000-4000-8000-000000000000/generate`,
      headers: { authorization: `Bearer ${keyUserToken}` },
    });
    expect(gen.statusCode).toBe(403);
    const asm = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/manuals/${generationId}/assemble`,
      headers: { authorization: `Bearer ${keyUserToken}` },
    });
    expect(asm.statusCode).toBe(403);
    const pub = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/manuals/${generationId}/publish`,
      headers: { authorization: `Bearer ${keyUserToken}` },
    });
    expect(pub.statusCode).toBe(403);
    // 项目成员可查看会话详情（AC1 之外：查看 = 项目成员）
    const byMemberManual = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/manuals/${generationId}`,
      headers: { authorization: `Bearer ${keyUserToken}` },
    });
    expect(byMemberManual.statusCode).toBe(200);
  });

  it('审计：manual.create/chapter_generate/chapter_update/assemble/publish 全部落库', async () => {
    const owner = connectOwner();
    try {
      const creates = await owner`select metadata from audit_logs where action = 'manual.create'`;
      expect(creates.length).toBe(1);
      const createMeta = JSON.parse(creates[0].metadata as string) as {
        blueprintId: string;
        blueprintVersion: number;
        chapterCount: number;
      };
      expect(createMeta.blueprintId).toBe(blueprintId);
      expect(createMeta.blueprintVersion).toBe(1);
      expect(createMeta.chapterCount).toBe(5);

      const generates = await owner`select count(*)::int as n from audit_logs where action = 'manual.chapter_generate'`;
      expect(generates[0].n).toBeGreaterThanOrEqual(6); // 5 章 + 1 次重生成

      const updates = await owner`select count(*)::int as n from audit_logs where action = 'manual.chapter_update'`;
      expect(updates[0].n).toBeGreaterThanOrEqual(1);

      const assembles = await owner`select count(*)::int as n from audit_logs where action = 'manual.assemble'`;
      expect(assembles[0].n).toBeGreaterThanOrEqual(1);

      const publishes = await owner`select count(*)::int as n from audit_logs where action = 'manual.publish'`;
      expect(publishes[0].n).toBe(1);
    } finally {
      await owner.end();
    }
  });
});
