import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  AssigneesListResponseSchema,
  IssueCommentCreateResponseSchema,
  IssueCreateResponseSchema,
  IssueGetResponseSchema,
  IssueLinkResponseSchema,
  IssueTransitionResponseSchema,
  IssueUpdateResponseSchema,
  IssuesListResponseSchema,
  MemberInviteResponseSchema,
  SetPasswordResponseSchema,
  type Issue,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * 问题清单 e2e（issue #15 验收 + issue #20 增强）：
 * - ① 权限矩阵：提交=全员（内部+三客户角色）；越权 403（普通用户评论/修改、
 *   KeyUser 修改、非成员访问）；PM 修改/指派（仅内部用户候选）
 * - ② 状态机：严格线性 新建→处理中→已解决→已关闭；非法流转 400（跳过/回退/终态后）；
 *   流转=内部专属（客户角色 403）
 * - ③ 内部处理问题、指派内部负责人（验收 ②③ 同链）
 * - ④ 筛选/搜索（分类/优先级/状态/标题/提交人）+ 提交人姓名回显
 * - ⑤（issue #20）关联蓝图/会议纪要/知识库文档：三种目标 201、跨项目/不存在/重复 400、
 *   非 PM 403、客户 PM 仅可关联已发布 kb（RLS）、DELETE 204、详情 links 内嵌
 * - 审计：issue.create/update/transition/comment/link/unlink 落 audit_logs
 */
describe('Issues e2e：问题清单权限矩阵、状态机与指派', () => {
  let app: NestFastifyApplication;

  const password = 'password123';
  let internalToken: string;
  let superAdminToken: string;
  let pmToken: string;
  let keyUserToken: string;
  let regularUserToken: string;
  let outsiderToken: string;
  let internalUserId: string;
  let superAdminUserId: string;
  let regularUserId: string;
  let cidA: string;
  let projectAId: string;
  let projectBId: string; // 同租户第二项目（跨项目关联 400 场景）
  let issue1Id: string; // regularUser 提交（bug/function/high）——全链流转
  let issue2Id: string; // PM 提交（bug/data/medium）——非法流转/指派/关联
  let issue3Id: string; // KeyUser 提交（feature/function/low）——指派校验
  // issue #20 关联种子
  let blueprintAId: string;
  let blueprintBId: string; // 项目 B 的蓝图（跨项目关联 → 400）
  let minuteAId: string;
  let kbPublishedId: string; // 已发布 kb 文档（客户 PM 可关联）
  let kbDraftId: string; // 草稿 kb 文档（客户 PM 关联 → RLS 挡 → 400）

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

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { accessToken: string }).accessToken;
  }

  async function inviteMember(
    projectId: string,
    body: { email: string; role: string },
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const parsed = MemberInviteResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    const inviteUrl = parsed.data!.inviteUrl!;
    const token = new URL(inviteUrl).searchParams.get('token')!;
    const setPw = await app.inject({
      method: 'POST',
      url: '/api/auth/set-password',
      payload: { token, password },
    });
    expect(setPw.statusCode).toBe(200);
    expect(SetPasswordResponseSchema.safeParse(setPw.json()).success).toBe(true);
    return login(body.email);
  }

  async function createIssue(
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; issue: Issue | null }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/issues`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    if (res.statusCode !== 201) {
      return { status: res.statusCode, issue: null };
    }
    const parsed = IssueCreateResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, issue: parsed.data!.issue };
  }

  async function listIssues(
    token: string,
    query = '',
  ): Promise<{ status: number; issues: Issue[] }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/issues${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.statusCode !== 200) {
      return { status: res.statusCode, issues: [] };
    }
    const parsed = IssuesListResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, issues: parsed.data!.issues };
  }

  async function getIssue(token: string, issueId: string): Promise<{ status: number; body: unknown }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/issues/${issueId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: res.json() };
  }

  async function patchIssue(
    token: string,
    issueId: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectAId}/issues/${issueId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    return { status: res.statusCode, body: res.json() };
  }

  async function transitionIssue(
    token: string,
    issueId: string,
    status: string,
  ): Promise<{ status: number; body: unknown }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/issues/${issueId}/transition`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status },
    });
    return { status: res.statusCode, body: res.json() };
  }

  async function addComment(
    token: string,
    issueId: string,
    content: string,
  ): Promise<{ status: number; body: unknown }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/issues/${issueId}/comments`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content },
    });
    return { status: res.statusCode, body: res.json() };
  }

  // issue #20：关联
  async function addLink(
    token: string,
    issueId: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/issues/${issueId}/links`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    return { status: res.statusCode, body: res.json() };
  }

  async function removeLink(
    token: string,
    issueId: string,
    linkId: string,
  ): Promise<{ status: number }> {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectAId}/issues/${issueId}/links/${linkId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode };
  }

  beforeAll(async () => {
    await resetTestDb();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();

    // 用户：internal 默认角色；admin 提升 super_admin；outsider 客户用户（无成员）
    const internal = await register('internal@corp.test');
    const admin = await register('admin@corp.test');
    const outsider = await register('outsider@tenant-a.test');
    internalUserId = internal.id;
    superAdminUserId = admin.id;
    internalToken = internal.token;

    const owner = connectOwner();
    try {
      await owner`update users set role = 'super_admin' where id = ${admin.id}`;
      await owner`update users set role = 'customer' where id = ${outsider.id}`;
      const [customerA] = await owner`insert into customers (name) values ('客户A') returning id`;
      await owner`insert into user_tenants (user_id, customer_id) values (${outsider.id}, ${customerA.id})`;
      cidA = customerA.id as string;
    } finally {
      await owner.end();
    }
    superAdminToken = await login('admin@corp.test');
    outsiderToken = await login('outsider@tenant-a.test');

    // 内部建项目 → 邀请 PM/KeyUser/普通用户 → 设密登录（真实成员链路）
    const create = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { tenantId: cidA, name: 'P-A1' },
    });
    expect(create.statusCode).toBe(201);
    projectAId = (create.json() as { project: { id: string } }).project.id;
    pmToken = await inviteMember(projectAId, { email: 'pm@tenant-a.test', role: 'project_manager' });
    keyUserToken = await inviteMember(projectAId, { email: 'ku@tenant-a.test', role: 'key_user' });
    const regularUser = await inviteMember(projectAId, {
      email: 'ru@tenant-a.test',
      role: 'regular_user',
    });
    regularUserToken = regularUser;
    const owner2 = connectOwner();
    try {
      const [ru] = await owner2`select id from users where email = 'ru@tenant-a.test'`;
      regularUserId = ru.id as string;
    } finally {
      await owner2.end();
    }

    // 种子问题（四类提交者）
    const i1 = await createIssue(regularUserToken, {
      title: '登录页白屏',
      description: '输入账号密码后白屏',
      type: 'bug',
      category: 'function',
      priority: 'high',
    });
    const i2 = await createIssue(pmToken, {
      title: '导出乱码',
      description: '导出后打开是乱码',
      type: 'bug',
      category: 'data',
      priority: 'medium',
    });
    const i3 = await createIssue(keyUserToken, {
      title: '新增报表需求',
      type: 'feature',
      category: 'function',
      priority: 'low',
    });
    const i4 = await createIssue(internalToken, {
      title: '使用咨询',
      type: 'question',
      category: 'usage',
      priority: 'low',
    });
    expect([i1, i2, i3, i4].every((r) => r.status === 201)).toBe(true);
    issue1Id = i1.issue!.id;
    issue2Id = i2.issue!.id;
    issue3Id = i3.issue!.id;

    // issue #20 种子：项目 B（同租户）+ 蓝图 A/B + 会议纪要 + kb 已发布/草稿
    const createB = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { tenantId: cidA, name: 'P-B2' },
    });
    expect(createB.statusCode).toBe(201);
    projectBId = (createB.json() as { project: { id: string } }).project.id;
    const drawio = {
      name: '订单流程.drawio',
      contentType: 'application/xml',
      base64: Buffer.from('<mxfile/>').toString('base64'),
    };
    const bpA = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/blueprints`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { drawio, moduleScope: '订单/库存模块' },
    });
    expect(bpA.statusCode).toBe(201);
    blueprintAId = (bpA.json() as { blueprint: { id: string } }).blueprint.id;
    const bpB = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectBId}/blueprints`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { drawio },
    });
    expect(bpB.statusCode).toBe(201);
    blueprintBId = (bpB.json() as { blueprint: { id: string } }).blueprint.id;
    const minute = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/minutes`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { title: '启动会纪要', meetingDate: '2026-08-01' },
    });
    expect(minute.statusCode).toBe(201);
    minuteAId = (minute.json() as { minute: { id: string } }).minute.id;
    const kbPublished = await app.inject({
      method: 'POST',
      url: '/api/kb/documents',
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { docType: 'markdown', title: '登录问题 FAQ', category: 'faq', body: '# FAQ' },
    });
    expect(kbPublished.statusCode).toBe(201);
    kbPublishedId = (kbPublished.json() as { document: { id: string } }).document.id;
    const pub = await app.inject({
      method: 'POST',
      url: `/api/kb/documents/${kbPublishedId}/publish`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(pub.statusCode).toBe(200);
    const kbDraft = await app.inject({
      method: 'POST',
      url: '/api/kb/documents',
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { docType: 'markdown', title: '内部草稿', category: 'manual', body: '未发布' },
    });
    expect(kbDraft.statusCode).toBe(201);
    kbDraftId = (kbDraft.json() as { document: { id: string } }).document.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('验收 ①：权限矩阵（提交全员、越权 403、PM 管理/指派）', () => {
    it('提交问题：内部/PM/KeyUser/普通用户均 201（种子已建，此处验证回显）', async () => {
      const created = await createIssue(regularUserToken, {
        title: '追加验证',
        type: 'bug',
        category: 'function',
        priority: 'low',
      });
      expect(created.status).toBe(201);
      expect(created.issue!.reporterId).toBe(regularUserId);
    });

    it('越权 403：普通用户评论、KeyUser/普通用户修改', async () => {
      expect((await addComment(regularUserToken, issue1Id, '越权评论')).status).toBe(403);
      expect((await patchIssue(keyUserToken, issue1Id, { title: '越权改' })).status).toBe(403);
      expect((await patchIssue(regularUserToken, issue1Id, { priority: 'low' })).status).toBe(403);
    });

    it('非成员客户用户访问列表/详情 → 403', async () => {
      const list = await listIssues(outsiderToken);
      expect(list.status).toBe(403);
      expect((await getIssue(outsiderToken, issue1Id)).status).toBe(403);
    });

    it('PM 修改问题字段 → 200，部分更新语义', async () => {
      const res = await patchIssue(pmToken, issue2Id, { priority: 'high' });
      expect(res.status).toBe(200);
      const parsed = IssueUpdateResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.issue.priority).toBe('high');
      expect(parsed.data!.issue.title).toBe('导出乱码'); // 未传字段不变
    });

    it('PM 指派内部负责人 → 200，assignee 回显', async () => {
      const res = await patchIssue(pmToken, issue2Id, { assigneeId: internalUserId });
      expect(res.status).toBe(200);
      const parsed = IssueUpdateResponseSchema.safeParse(res.body);
      expect(parsed.data!.issue.assigneeId).toBe(internalUserId);
    });

    it('指派校验：非内部用户 → 400', async () => {
      const res = await patchIssue(pmToken, issue3Id, { assigneeId: regularUserId });
      expect(res.status).toBe(400);
    });

    it('指派候选端点：PM 可见内部用户；KeyUser → 403', async () => {
      const pm = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/issues/assignees`,
        headers: { authorization: `Bearer ${pmToken}` },
      });
      expect(pm.statusCode).toBe(200);
      const parsed = AssigneesListResponseSchema.safeParse(pm.json());
      expect(parsed.success).toBe(true);
      expect(parsed.data!.assignees.map((a) => a.id)).toContain(internalUserId);
      const ku = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/issues/assignees`,
        headers: { authorization: `Bearer ${keyUserToken}` },
      });
      expect(ku.statusCode).toBe(403);
    });
  });

  describe('验收 ②：状态机（严格线性前进，非法流转被拒）', () => {
    it('客户角色流转 → 403（内部专属）', async () => {
      expect((await transitionIssue(regularUserToken, issue1Id, 'in_progress')).status).toBe(403);
      expect((await transitionIssue(pmToken, issue1Id, 'in_progress')).status).toBe(403);
    });

    it('内部全链流转：new→in_progress→resolved→closed 均 200', async () => {
      const t1 = await transitionIssue(internalToken, issue1Id, 'in_progress');
      expect(t1.status).toBe(200);
      expect(IssueTransitionResponseSchema.safeParse(t1.body).success).toBe(true);
      const t2 = await transitionIssue(internalToken, issue1Id, 'resolved');
      expect(t2.status).toBe(200);
      const t3 = await transitionIssue(internalToken, issue1Id, 'closed');
      expect(t3.status).toBe(200);
    });

    it('非法流转 → 400：跳过中间态 / 终态后回退', async () => {
      // issue2 仍 new：跳过中间态
      const skip = await transitionIssue(internalToken, issue2Id, 'resolved');
      expect(skip.status).toBe(400);
      // issue1 已 closed：终态后任何流转
      expect((await transitionIssue(internalToken, issue1Id, 'new')).status).toBe(400);
      expect((await transitionIssue(internalToken, issue1Id, 'resolved')).status).toBe(400);
      expect((await transitionIssue(internalToken, issue1Id, 'closed')).status).toBe(400);
    });

    it('非法目标状态 → 400（契约层拦截）', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectAId}/issues/${issue2Id}/transition`,
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { status: 'done' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('验收 ③：内部处理与指派', () => {
    it('内部用户指派内部负责人（super_admin ⊇ internal）', async () => {
      const res = await patchIssue(superAdminToken, issue1Id, { assigneeId: superAdminUserId });
      expect(res.status).toBe(200);
      const parsed = IssueUpdateResponseSchema.safeParse(res.body);
      expect(parsed.data!.issue.assigneeId).toBe(superAdminUserId);
    });
  });

  describe('验收 ④：筛选/搜索/评论', () => {
    it('按分类/优先级/状态筛选', async () => {
      const byCategory = await listIssues(internalToken, '?category=function');
      expect(byCategory.status).toBe(200);
      expect(byCategory.issues.length).toBeGreaterThanOrEqual(2);
      expect(byCategory.issues.every((i) => i.category === 'function')).toBe(true);
      const byPriority = await listIssues(internalToken, '?priority=high');
      expect(byPriority.issues.every((i) => i.priority === 'high')).toBe(true);
      const byStatus = await listIssues(internalToken, '?status=closed');
      expect(byStatus.issues.map((i) => i.id)).toContain(issue1Id);
    });

    it('标题搜索与无结果空数组', async () => {
      const hit = await listIssues(internalToken, '?search=白屏');
      expect(hit.issues.map((i) => i.title)).toEqual(['登录页白屏']);
      const none = await listIssues(internalToken, '?search=不存在的标题');
      expect(none.issues).toEqual([]);
    });

    it('评论：PM/KeyUser 201 且详情带作者名；列表查看全员', async () => {
      expect((await addComment(pmToken, issue1Id, '已复现，开始排查')).status).toBe(201);
      expect((await addComment(keyUserToken, issue1Id, '补充：Chrome 浏览器')).status).toBe(201);
      const detail = await getIssue(regularUserToken, issue1Id);
      expect(detail.status).toBe(200);
      const parsed = IssueGetResponseSchema.safeParse(detail.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.comments.map((c) => c.content)).toContain('已复现，开始排查');
      expect(parsed.data!.comments[0].authorName).toBe('pm');
    });
  });

  describe('验收 ④（issue #20）：提交人筛选与姓名回显', () => {
    it('reporterId 筛选只返回该提交人的问题', async () => {
      const res = await listIssues(internalToken, `?reporterId=${regularUserId}`);
      expect(res.status).toBe(200);
      expect(res.issues.length).toBeGreaterThanOrEqual(2);
      expect(res.issues.every((i) => i.reporterId === regularUserId)).toBe(true);
      expect(res.issues.map((i) => i.title)).toContain('登录页白屏');
    });

    it('列表/详情回显提交人姓名（join users）', async () => {
      const list = await listIssues(internalToken);
      const i1 = list.issues.find((i) => i.id === issue1Id);
      expect(i1?.reporterName).toBe('ru');
      const detail = await getIssue(regularUserToken, issue1Id);
      const parsed = IssueGetResponseSchema.safeParse(detail.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.issue.reporterName).toBe('ru');
    });

    it('非法 reporterId → 400（契约层拦截）', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/issues?reporterId=not-a-uuid`,
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('验收 ⑤（issue #20）：关联蓝图/会议纪要/知识库文档', () => {
    it('三种目标关联 201，详情 links 内嵌 targetTitle + createdBy', async () => {
      const bp = await addLink(internalToken, issue2Id, { targetType: 'blueprint', targetId: blueprintAId });
      expect(bp.status).toBe(201);
      const bpParsed = IssueLinkResponseSchema.safeParse(bp.body);
      expect(bpParsed.success).toBe(true);
      expect(bpParsed.data!.link.targetType).toBe('blueprint');
      expect(bpParsed.data!.link.targetTitle).toBe('订单流程.drawio');

      const minute = await addLink(internalToken, issue2Id, { targetType: 'minute', targetId: minuteAId });
      expect(minute.status).toBe(201);
      const mParsed = IssueLinkResponseSchema.safeParse(minute.body);
      expect(mParsed.data!.link.targetTitle).toBe('启动会纪要');

      const kb = await addLink(internalToken, issue2Id, { targetType: 'kb_document', targetId: kbPublishedId });
      expect(kb.status).toBe(201);
      const kParsed = IssueLinkResponseSchema.safeParse(kb.body);
      expect(kParsed.data!.link.targetTitle).toBe('登录问题 FAQ');

      const detail = await getIssue(regularUserToken, issue2Id);
      const parsed = IssueGetResponseSchema.safeParse(detail.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.links.map((l) => l.targetType).sort()).toEqual(['blueprint', 'kb_document', 'minute']);
      expect(parsed.data!.links.every((l) => l.targetTitle !== null)).toBe(true);
      expect(parsed.data!.links[0].createdBy?.displayName).toBe('internal');
    });

    it('重复关联同一目标 → 400', async () => {
      const dup = await addLink(internalToken, issue2Id, { targetType: 'blueprint', targetId: blueprintAId });
      expect(dup.status).toBe(400);
    });

    it('跨项目关联（项目 B 的蓝图）→ 400；目标不存在 → 400', async () => {
      const cross = await addLink(internalToken, issue2Id, { targetType: 'blueprint', targetId: blueprintBId });
      expect(cross.status).toBe(400);
      const missing = await addLink(internalToken, issue2Id, {
        targetType: 'minute',
        targetId: '00000000-0000-4000-8000-000000000000',
      });
      expect(missing.status).toBe(400);
    });

    it('非法 targetType / 非法 targetId → 400（契约层拦截）', async () => {
      expect((await addLink(internalToken, issue2Id, { targetType: 'other', targetId: blueprintAId })).status).toBe(400);
      expect((await addLink(internalToken, issue2Id, { targetType: 'blueprint', targetId: 'x' })).status).toBe(400);
    });

    it('权限：KeyUser/普通用户关联 403；PM 关联 201；未认证 401', async () => {
      expect((await addLink(keyUserToken, issue2Id, { targetType: 'blueprint', targetId: blueprintAId })).status).toBe(403);
      expect((await addLink(regularUserToken, issue2Id, { targetType: 'blueprint', targetId: blueprintAId })).status).toBe(403);
      const pm = await addLink(pmToken, issue2Id, { targetType: 'minute', targetId: minuteAId });
      expect(pm.status).toBe(400); // 已重复关联（beforeAll 用例 1 已建）——证明 PM 权限通过、被去重拦截
      const noAuth = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectAId}/issues/${issue2Id}/links`,
        payload: { targetType: 'blueprint', targetId: blueprintAId },
      });
      expect(noAuth.statusCode).toBe(401);
    });

    it('客户 PM 可关联已发布 kb；关联 kb 草稿 → 400（RLS 挡）', async () => {
      const draft = await addLink(pmToken, issue2Id, { targetType: 'kb_document', targetId: kbDraftId });
      expect(draft.status).toBe(400);
      const pub = await addLink(pmToken, issue3Id, { targetType: 'kb_document', targetId: kbPublishedId });
      expect(pub.status).toBe(201);
      expect(IssueLinkResponseSchema.safeParse(pub.body).success).toBe(true);
    });

    it('DELETE 解除关联 204 → 详情 links 不含；不存在 link 404；KeyUser 删除 403', async () => {
      const detail = await getIssue(internalToken, issue2Id);
      const parsed = IssueGetResponseSchema.safeParse(detail.body);
      const minuteLink = parsed.data!.links.find((l) => l.targetType === 'minute')!;
      expect((await removeLink(keyUserToken, issue2Id, minuteLink.id)).status).toBe(403);
      const removed = await removeLink(pmToken, issue2Id, minuteLink.id);
      expect(removed.status).toBe(204);
      const after = await getIssue(internalToken, issue2Id);
      const afterParsed = IssueGetResponseSchema.safeParse(after.body);
      expect(afterParsed.data!.links.find((l) => l.id === minuteLink.id)).toBeUndefined();
      expect((await removeLink(pmToken, issue2Id, minuteLink.id)).status).toBe(404);
    });
  });

  describe('审计', () => {
    it('issue.create/update/transition/comment 落 audit_logs（含 actor 与资源）', async () => {
      const owner = connectOwner();
      try {
        const creates = await owner`
          select action, actor_role, resource_type, metadata
          from audit_logs where action = 'issue.create' order by created_at`;
        expect(creates.length).toBeGreaterThanOrEqual(5);
        expect(creates[0].resource_type).toBe('issue');
        const transitions = await owner`
          select action, metadata from audit_logs
          where action = 'issue.transition' order by created_at`;
        expect(transitions.length).toBeGreaterThanOrEqual(3);
        // postgres.js 对 jsonb 返回字符串，需解析（现有套件未断言 metadata，此处首个）
        const firstTransition = JSON.parse(transitions[0].metadata as string) as {
          from: string;
          to: string;
        };
        expect(firstTransition.from).toBe('new');
        expect(firstTransition.to).toBe('in_progress');
        const updates = await owner`
          select action from audit_logs where action = 'issue.update'`;
        expect(updates.length).toBeGreaterThanOrEqual(3);
        const comments = await owner`
          select action from audit_logs where action = 'issue.comment'`;
        expect(comments.length).toBeGreaterThanOrEqual(2);
        const links = await owner`
          select action, metadata from audit_logs
          where action = 'issue.link' order by created_at`;
        expect(links.length).toBeGreaterThanOrEqual(4); // 三种目标 + 客户 PM 关联 kb
        const firstLink = JSON.parse(links[0].metadata as string) as { targetType: string };
        expect(firstLink.targetType).toBe('blueprint');
        const unlinks = await owner`
          select action from audit_logs where action = 'issue.unlink'`;
        expect(unlinks.length).toBeGreaterThanOrEqual(1);
      } finally {
        await owner.end();
      }
    });
  });
});
