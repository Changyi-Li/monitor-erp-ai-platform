import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  AttachmentResponseSchema,
  BlueprintPublishResponseSchema,
  BlueprintVersionGetResponseSchema,
  BlueprintVersionsListResponseSchema,
  IssueCommentCreateResponseSchema,
  IssueCreateResponseSchema,
  IssueGetResponseSchema,
  IssuesListResponseSchema,
  KbDocumentResponseSchema,
  KbListResponseSchema,
  KbVersionsResponseSchema,
  ManualGenerationsListResponseSchema,
  MeResponseSchema,
  MemberInviteResponseSchema,
  MinuteGetResponseSchema,
  MinuteResponseSchema,
  MinutesListResponseSchema,
  ProjectGetResponseSchema,
  ProjectsListResponseSchema,
  RiskResponseSchema,
  RisksListResponseSchema,
  SetPasswordResponseSchema,
  StageResponseSchema,
  StageTemplatesResponseSchema,
  StagesListResponseSchema,
  RagSyncsResponseSchema,
  type RagSync,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * 客户门户端到端验收（issue #27，spec §10 端到端验收）：
 * - ① 客户全流程一条龙（客户 A regular 视角）：登录 → 项目列表（含 A1 不含 B1）→
 *   项目详情 viewerRole → 只读各域（蓝图版本/阶段模板/风险/纪要附件/问题）→
 *   提交问题（全员）→ 知识库合一视图（全局文档 + 本项目文档，不含异租户）
 * - ② 跨客户渗透矩阵（spec 红线「自动化渗透测试，上线门禁」）：客户 A 凭证 ×
 *   客户 B 全部资源 → 全 404 防探测；kb 项目文档跨租户不可见（全局文档共享语义不变）；
 *   权限矩阵抽测（risk assignees 客户 403 / stage templates、blueprint versions 客户 200）
 */
describe('Portal e2e：客户门户端到端验收', () => {
  let app: NestFastifyApplication;

  const password = 'password123';
  const DRAWIO_FIXTURE = '<mxfile><diagram name="v1">A</diagram></mxfile>';

  let internalToken: string;
  let customerAToken: string; // 客户 A regular（全流程主角）
  let regularAId: string;
  let projectAId: string;
  let projectBId: string;
  let customerAId: string;
  let blueprintAId: string;
  let stageAId: string;
  let riskAId: string;
  let minuteAId: string;
  let attachmentAId: string;
  let seededIssueAId: string;
  let kbGlobalId: string;
  let kbProjectAId: string;
  let kbProjectBId: string;
  let kbVersionAId: string;
  let blueprintBId: string;
  let minuteBId: string;
  let attachmentBId: string;
  let issueBId: string;

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

  /**
   * 邀请成员：新账号 → 邀请链接设密登录；同租户已激活账号（register 已建号设密）
   * → 直接加成员（inviteUrl=null）→ 直接登录。
   */
  async function inviteMember(projectId: string, email: string, role: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { email, role },
    });
    expect(res.statusCode).toBe(201);
    const parsed = MemberInviteResponseSchema.parse(res.json());
    if (!parsed.inviteUrl) {
      return login(email); // 已激活账号：直接成为成员（register 已设密码）
    }
    const inviteUrl = parsed.inviteUrl;
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

  /** 内部在项目下种蓝图（返回 blueprintId） */
  async function seedBlueprint(projectId: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/blueprints`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: {
        drawio: drawioUpload(DRAWIO_FIXTURE),
        businessRequirements: '业务需求',
        moduleScope: '模块范围',
      },
    });
    expect(res.statusCode).toBe(201);
    return BlueprintPublishResponseSchema.parse(res.json()).blueprint.id;
  }

  /** 内部在项目下种阶段（返回 stageId） */
  async function seedStage(projectId: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/stages`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { templateKey: 'requirements', name: '需求分析', description: '调研业务流程' },
    });
    expect(res.statusCode).toBe(201);
    return StageResponseSchema.parse(res.json()).stage.id;
  }

  /** 内部在项目下种风险（返回 riskId） */
  async function seedRisk(projectId: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/risks`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { description: '关键用户中途更换', level: 'high' },
    });
    expect(res.statusCode).toBe(201);
    return RiskResponseSchema.parse(res.json()).risk.id;
  }

  /** 内部在项目下种纪要 + 附件（返回 {minuteId, attachmentId}） */
  async function seedMinute(
    projectId: string,
  ): Promise<{ minuteId: string; attachmentId: string }> {
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/minutes`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: {
        title: '启动会纪要',
        meetingDate: '2026-08-01',
        participants: '客户 PM、实施顾问',
        body: '<p>项目启动与里程碑确认。</p>',
      },
    });
    expect(create.statusCode).toBe(201);
    const minuteId = MinuteResponseSchema.parse(create.json()).minute.id;
    const upload = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/minutes/${minuteId}/attachments`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: {
        name: '会议资料.pdf',
        contentType: 'application/pdf',
        base64: Buffer.from('会议附件内容', 'utf8').toString('base64'),
      },
    });
    expect(upload.statusCode).toBe(201);
    return { minuteId, attachmentId: AttachmentResponseSchema.parse(upload.json()).attachment.id };
  }

  /** 内部在项目下种问题（返回 issueId） */
  async function seedIssue(projectId: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/issues`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: {
        title: '预置问题',
        description: '由内部预置的数据',
        type: 'bug',
        category: 'function',
        priority: 'medium',
      },
    });
    expect(res.statusCode).toBe(201);
    return IssueCreateResponseSchema.parse(res.json()).issue.id;
  }

  /** 内部创建 kb 文档（markdown；可挂项目）并发布（返回 documentId） */
  async function seedKbDocument(title: string, projectId?: string): Promise<string> {
    const create = await app.inject({
      method: 'POST',
      url: '/api/kb/documents',
      headers: { authorization: `Bearer ${internalToken}` },
      payload: {
        docType: 'markdown',
        ...(projectId ? { projectId } : {}),
        title,
        category: 'faq',
        body: `# ${title}\n\n${title} 的正文内容。`,
      },
    });
    expect(create.statusCode).toBe(201);
    const documentId = KbDocumentResponseSchema.parse(create.json()).document.id;
    const pub = await app.inject({
      method: 'POST',
      url: `/api/kb/documents/${documentId}/publish`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(pub.statusCode).toBe(200);
    expect(KbDocumentResponseSchema.parse(pub.json()).document.status).toBe('published');
    return documentId;
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
    const pmA = await register('pm-a@tenant-a.test');
    const regularA = await register('ru-a@tenant-a.test');
    const pmB = await register('pm-b@tenant-b.test');
    internalToken = internal.token;
    regularAId = regularA.id;

    const owner = connectOwner();
    try {
      for (const id of [pmA.id, regularA.id, pmB.id]) {
        await owner`update users set role = 'customer' where id = ${id}`;
      }
      const [customerA] = await owner`insert into customers (name) values ('客户A') returning id`;
      const [customerB] = await owner`insert into customers (name) values ('客户B') returning id`;
      await owner`insert into user_tenants (user_id, customer_id) values (${pmA.id}, ${customerA.id})`;
      await owner`insert into user_tenants (user_id, customer_id) values (${regularA.id}, ${customerA.id})`;
      await owner`insert into user_tenants (user_id, customer_id) values (${pmB.id}, ${customerB.id})`;
      customerAId = customerA.id as string;
      const [projectA] = await owner`
        insert into projects (tenant_id, name) values (${customerAId}, 'P-A1') returning id`;
      const [projectB] = await owner`
        insert into projects (tenant_id, name) values (${customerB.id}, 'P-B1') returning id`;
      projectAId = projectA.id as string;
      projectBId = projectB.id as string;
    } finally {
      await owner.end();
    }

    // 真实成员链路：客户 A PM + regular、客户 B PM
    await inviteMember(projectAId, 'pm-a@tenant-a.test', 'project_manager');
    customerAToken = await inviteMember(projectAId, 'ru-a@tenant-a.test', 'regular_user');
    await inviteMember(projectBId, 'pm-b@tenant-b.test', 'project_manager');

    // 项目 A1 种数据（内部）
    blueprintAId = await seedBlueprint(projectAId);
    stageAId = await seedStage(projectAId);
    riskAId = await seedRisk(projectAId);
    ({ minuteId: minuteAId, attachmentId: attachmentAId } = await seedMinute(projectAId));
    seededIssueAId = await seedIssue(projectAId);

    // 项目 B1 种数据（内部）——渗透矩阵目标
    blueprintBId = await seedBlueprint(projectBId);
    await seedStage(projectBId);
    await seedRisk(projectBId);
    ({ minuteId: minuteBId, attachmentId: attachmentBId } = await seedMinute(projectBId));
    issueBId = await seedIssue(projectBId);

    // 知识库：全局文档（无 projectId）+ A1/B1 项目文档（均已发布）
    kbGlobalId = await seedKbDocument('全局 FAQ');
    kbProjectAId = await seedKbDocument('A1 项目文档', projectAId);
    kbProjectBId = await seedKbDocument('B1 项目文档', projectBId);

    // 等待三条发布链路全部同步完成（fixture 完整性：worker 处理不残留）
    await waitSyncs(
      (s) =>
        [kbGlobalId, kbProjectAId, kbProjectBId].every((id) =>
          s.some((x) => x.documentId === id && x.action === 'upsert' && x.status === 'succeeded'),
        ),
    );

    // 取 A1 项目文档的已发布版本 id（内部端点；客户 403 抽测用）
    const versions = await app.inject({
      method: 'GET',
      url: `/api/kb/documents/${kbProjectAId}/versions`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(versions.statusCode).toBe(200);
    const parsed = KbVersionsResponseSchema.safeParse(versions.json());
    expect(parsed.success).toBe(true);
    const published = parsed.data!.versions.find((v) => v.versionNumber !== null)!;
    kbVersionAId = published.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('验收①：客户全流程一条龙（客户 A regular 视角）', () => {
    it('登录 → /api/me → 项目列表（含 A1 不含 B1）→ 项目详情 viewerRole=regular_user', async () => {
      // 登录（register 已返回 token；再走一次 login 验证会话链路）
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'ru-a@tenant-a.test', password },
      });
      expect(loginRes.statusCode).toBe(200);
      const token = (loginRes.json() as { accessToken: string }).accessToken;

      const me = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(200);
      expect(MeResponseSchema.parse(me.json()).user.id).toBe(regularAId);

      const projects = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(projects.statusCode).toBe(200);
      const list = ProjectsListResponseSchema.parse(projects.json()).projects;
      expect(list.map((p) => p.id)).toContain(projectAId);
      expect(list.map((p) => p.id)).not.toContain(projectBId); // 跨客户项目不可见

      const detail = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(detail.statusCode).toBe(200);
      const parsed = ProjectGetResponseSchema.parse(detail.json());
      expect(parsed.project.id).toBe(projectAId);
      expect(parsed.viewerRole).toBe('regular_user');
    });

    it('只读各域 200：蓝图（详情+版本历史+版本详情+原文件下载）→ 阶段（+模板）→ 风险 → 纪要（+附件下载）→ 问题', async () => {
      // 蓝图：详情 + 版本列表 + 版本详情 + 原文件下载（补缺口②）
      const bp = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/blueprints`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(bp.statusCode).toBe(200);
      const bpDetail = bp.json() as { blueprint: { id: string } };
      expect(bpDetail.blueprint.id).toBe(blueprintAId);

      const versions = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/blueprints/versions`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(versions.statusCode).toBe(200);
      expect(BlueprintVersionsListResponseSchema.parse(versions.json()).versions.map((v) => v.version)).toEqual([1]);

      const version = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/blueprints/versions/1`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(version.statusCode).toBe(200);
      expect(BlueprintVersionGetResponseSchema.parse(version.json()).version.version).toBe(1);

      const file = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/blueprints/versions/1/file`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toContain('application/xml');
      expect(file.rawPayload.toString('utf8')).toBe(DRAWIO_FIXTURE);

      // 阶段 + 模板（补缺口③：templates 客户 200 无断言）
      const stages = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/stages`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(stages.statusCode).toBe(200);
      const stagesParsed = StagesListResponseSchema.parse(stages.json());
      expect(stagesParsed.stages.map((s) => s.id)).toContain(stageAId);
      expect(stagesParsed.viewerRole).toBe('regular_user');

      const templates = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/stages/templates`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(templates.statusCode).toBe(200);
      const tpl = StageTemplatesResponseSchema.parse(templates.json()).templates;
      expect(tpl.length).toBeGreaterThanOrEqual(5); // 内置标准模板全部可见
      expect(tpl.some((t) => t.key === 'requirements')).toBe(true);

      // 风险
      const risks = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/risks`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(risks.statusCode).toBe(200);
      const risksParsed = RisksListResponseSchema.parse(risks.json());
      expect(risksParsed.risks.map((r) => r.id)).toContain(riskAId);

      // 纪要：列表 + 详情 + 附件下载
      const minutes = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/minutes`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(minutes.statusCode).toBe(200);
      const minutesParsed = MinutesListResponseSchema.parse(minutes.json());
      expect(minutesParsed.minutes.map((m) => m.id)).toContain(minuteAId);

      const minute = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/minutes/${minuteAId}`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(minute.statusCode).toBe(200);
      const minuteParsed = MinuteGetResponseSchema.parse(minute.json());
      expect(minuteParsed.minute.attachments.map((a) => a.id)).toContain(attachmentAId);

      const attachment = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/minutes/${minuteAId}/attachments/${attachmentAId}/file`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(attachment.statusCode).toBe(200);
      expect(attachment.headers['content-type']).toContain('application/pdf');
      expect(attachment.rawPayload.toString('utf8')).toBe('会议附件内容');

      // 问题列表（含预置 + 待会提交）
      const issues = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/issues`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(issues.statusCode).toBe(200);
      expect(IssuesListResponseSchema.parse(issues.json()).issues.map((i) => i.id)).toContain(seededIssueAId);

      // 操作手册列表（客户只读可见）
      const manuals = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/manuals`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(manuals.statusCode).toBe(200);
      expect(ManualGenerationsListResponseSchema.safeParse(manuals.json()).success).toBe(true);
    });

    it('提交问题（全员 201）→ 详情可读 → 审计 issue.create actor = 客户本人', async () => {
      const create = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectAId}/issues`,
        headers: { authorization: `Bearer ${customerAToken}` },
        payload: {
          title: '客户提交的问题',
          description: '全流程验收中由客户提交',
          type: 'feature',
          category: 'usage',
          priority: 'high',
        },
      });
      expect(create.statusCode).toBe(201);
      const issueId = IssueCreateResponseSchema.parse(create.json()).issue.id;

      const detail = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/issues/${issueId}`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(detail.statusCode).toBe(200);
      const parsed = IssueGetResponseSchema.parse(detail.json());
      expect(parsed.issue.title).toBe('客户提交的问题');
      expect(parsed.issue.reporterName).toBe('ru-a'); // reporterId 由服务层取当前用户
      expect(parsed.viewerRole).toBe('regular_user');

      // 审计落库：actor 为客户用户本人（role=customer），资源 = 该问题
      const owner = connectOwner();
      try {
        const rows = await owner`
          select actor_user_id, actor_role from audit_logs
          where action = 'issue.create' and resource_id = ${issueId}`;
        expect(rows).toHaveLength(1);
        expect(rows[0].actor_user_id).toBe(regularAId);
        expect(rows[0].actor_role).toBe('customer');
      } finally {
        await owner.end();
      }
    });

    it('知识库合一视图：全局文档 + 本项目文档同列、不含异租户；详情可读；版本/内容端点客户 403', async () => {
      // 合一视图（补缺口⑤）：全局已发布 + 本项目文档；B1 项目文档被排除
      const list = await app.inject({
        method: 'GET',
        url: '/api/kb/documents',
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(list.statusCode).toBe(200);
      const docs = KbListResponseSchema.parse(list.json()).documents;
      const ids = docs.map((d) => d.id);
      expect(ids).toContain(kbGlobalId); // 全局共享语义不变
      expect(ids).toContain(kbProjectAId);
      const aDoc = docs.find((d) => d.id === kbProjectAId)!;
      expect(aDoc.projectId).toBe(projectAId);
      expect(aDoc.status).toBe('published');
      expect(ids).not.toContain(kbProjectBId); // 异租户项目文档不可见

      // 详情 200 + 正文可读
      const detail = await app.inject({
        method: 'GET',
        url: `/api/kb/documents/${kbProjectAId}`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(detail.statusCode).toBe(200);
      const detailParsed = KbDocumentResponseSchema.parse(detail.json());
      expect(detailParsed.document.body).toContain('A1 项目文档 的正文内容');
      expect(detailParsed.document.viewerRole).toBe('customer');

      // 维护端点抽测：版本历史 / 版本内容 → 客户 403（仅内部）
      const versions = await app.inject({
        method: 'GET',
        url: `/api/kb/documents/${kbProjectAId}/versions`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(versions.statusCode).toBe(403);
      const content = await app.inject({
        method: 'GET',
        url: `/api/kb/documents/${kbProjectAId}/versions/${kbVersionAId}/content`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(content.statusCode).toBe(403);
    });
  });

  describe('验收②：跨客户渗透矩阵（客户 A 凭证 × 客户 B 全部资源 → 404）', () => {
    const assertPenetration = async (method: string, url: string, payload?: unknown) => {
      const res = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${customerAToken}` },
        payload,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    };

    it('项目/蓝图/阶段/风险/纪要/问题/手册：全资源 404（防探测，不泄露存在性）', async () => {
      // 项目
      await assertPenetration('GET', `/api/projects/${projectBId}`);
      // 蓝图：详情 + 版本列表 + 版本详情 + 原文件下载
      await assertPenetration('GET', `/api/projects/${projectBId}/blueprints`);
      await assertPenetration('GET', `/api/projects/${projectBId}/blueprints/versions`);
      await assertPenetration('GET', `/api/projects/${projectBId}/blueprints/versions/1`);
      await assertPenetration('GET', `/api/projects/${projectBId}/blueprints/versions/1/file`);
      // 阶段 + 模板
      await assertPenetration('GET', `/api/projects/${projectBId}/stages`);
      await assertPenetration('GET', `/api/projects/${projectBId}/stages/templates`);
      // 风险
      await assertPenetration('GET', `/api/projects/${projectBId}/risks`);
      // 纪要：列表 + 详情 + 附件文件
      await assertPenetration('GET', `/api/projects/${projectBId}/minutes`);
      await assertPenetration('GET', `/api/projects/${projectBId}/minutes/${minuteBId}`);
      await assertPenetration(
        'GET',
        `/api/projects/${projectBId}/minutes/${minuteBId}/attachments/${attachmentBId}/file`,
      );
      // 问题：列表 + 详情 + 提交 + 评论
      await assertPenetration('GET', `/api/projects/${projectBId}/issues`);
      await assertPenetration('GET', `/api/projects/${projectBId}/issues/${issueBId}`);
      await assertPenetration('POST', `/api/projects/${projectBId}/issues`, {
        title: '渗透测试',
        type: 'bug',
        category: 'function',
        priority: 'high',
      });
      // 评论走「权限先于资源」（resolveViewerRole 在 requireIssue 前）→ 非成员 403；
      // 与 manual 域 ADR 0015 记录的顺序一致，不泄露 B1 数据存在性
      const comment = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectBId}/issues/${issueBId}/comments`,
        headers: { authorization: `Bearer ${customerAToken}` },
        payload: { content: '渗透测试评论' },
      });
      expect(comment.statusCode).toBe(403);
      // 操作手册：列表 + 创建
      await assertPenetration('GET', `/api/projects/${projectBId}/manuals`);
      await assertPenetration('POST', `/api/projects/${projectBId}/manuals`, {
        blueprintVersion: 1,
      });
      // 蓝图变量确认种数据成功（防止误断言：若 B1 蓝图未种，404 是「不存在」而非「隔离」）
      expect(blueprintBId).toBeTruthy();
    });

    it('知识库隔离：B1 项目文档详情 404；A 列表不含 B1（全局文档共享语义不变）', async () => {
      const detail = await app.inject({
        method: 'GET',
        url: `/api/kb/documents/${kbProjectBId}`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(detail.statusCode).toBe(404);

      const list = await app.inject({
        method: 'GET',
        url: '/api/kb/documents',
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(list.statusCode).toBe(200);
      const ids = KbListResponseSchema.parse(list.json()).documents.map((d) => d.id);
      expect(ids).not.toContain(kbProjectBId);
      expect(ids).toContain(kbGlobalId);
      expect(ids).toContain(kbProjectAId);
    });

    it('权限矩阵抽测：risk assignees 客户 403（补缺口④）；stages templates / blueprints versions 客户 200（补缺口③②）；rag 内部端点客户 403', async () => {
      // 风险负责人候选 = 内部用户列表 → 客户 403
      const assignees = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/risks/assignees`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(assignees.statusCode).toBe(403);

      // 阶段模板 / 蓝图版本：客户只读 200（同租户项目）
      const templates = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/stages/templates`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(templates.statusCode).toBe(200);
      const versions = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/blueprints/versions`,
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(versions.statusCode).toBe(200);

      // RAG 内部端点：客户 403（客户侧无检索端点，隔离已由 403 锁定）
      const index = await app.inject({
        method: 'GET',
        url: '/api/rag/index?scope=customer',
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(index.statusCode).toBe(403);
      const syncs = await app.inject({
        method: 'GET',
        url: '/api/rag/syncs',
        headers: { authorization: `Bearer ${customerAToken}` },
      });
      expect(syncs.statusCode).toBe(403);
    });
  });
});
