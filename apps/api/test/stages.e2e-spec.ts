import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  MemberInviteResponseSchema,
  RiskOwnersListResponseSchema,
  RiskResponseSchema,
  RisksListResponseSchema,
  SetPasswordResponseSchema,
  StageResponseSchema,
  StageTemplatesResponseSchema,
  StagesListResponseSchema,
  type Risk,
  type Stage,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * 实施阶段与风险 e2e（issue #17 验收）：
 * - ① 标准模板建阶段 → 项目内增删/排序调整 → 状态流转（自由四态）
 * - ② 风险创建、关联阶段、状态与负责人更新（负责人须内部；关联须本项目阶段）
 * - ③ 客户用户只读查看阶段进度与风险（修改请求 403）；非成员 403；跨租户 404
 * - 审计：stage.create/update/delete/reorder、risk.create/update/delete 落 audit_logs
 */
describe('Stages e2e：实施阶段与风险', () => {
  let app: NestFastifyApplication;

  const password = 'password123';

  let internalToken: string;
  let internalUserId: string;
  let pmToken: string;
  let keyUserToken: string;
  let regularUserToken: string;
  let outsiderToken: string; // 同租户非项目成员
  let crossTenantToken: string; // 另一客户（跨租户 → 404 防探测）
  let projectAId: string;
  let stageBId: string;
  let stageCId: string;

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

  async function listStages(token: string): Promise<{ status: number; stages: Stage[] }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/stages`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.statusCode !== 200) {
      return { status: res.statusCode, stages: [] };
    }
    const parsed = StagesListResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, stages: parsed.data!.stages };
  }

  async function listRisks(token: string): Promise<{ status: number; risks: Risk[] }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/risks`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.statusCode !== 200) {
      return { status: res.statusCode, risks: [] };
    }
    const parsed = RisksListResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, risks: parsed.data!.risks };
  }

  async function createStage(
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; stage: Stage | null }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/stages`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    if (res.statusCode !== 201) {
      return { status: res.statusCode, stage: null };
    }
    const parsed = StageResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, stage: parsed.data!.stage };
  }

  beforeAll(async () => {
    await resetTestDb();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();

    // 用户：internal 默认；outsider/crossTenant 为两个不同客户的客户用户
    const internal = await register('internal@corp.test');
    const outsider = await register('outsider@tenant-a.test');
    const crossTenant = await register('cross@tenant-b.test');
    internalToken = internal.token;
    internalUserId = internal.id;

    const owner = connectOwner();
    try {
      await owner`update users set role = 'customer_user' where id = ${outsider.id}`;
      await owner`update users set role = 'customer_user' where id = ${crossTenant.id}`;
      const [customerA] = await owner`insert into customers (name) values ('客户A') returning id`;
      const [customerB] = await owner`insert into customers (name) values ('客户B') returning id`;
      await owner`insert into user_tenants (user_id, customer_id) values (${outsider.id}, ${customerA.id})`;
      await owner`insert into user_tenants (user_id, customer_id) values (${crossTenant.id}, ${customerB.id})`;
      const cidA = customerA.id as string;
      // 项目 A 归客户 A
      const [projectA] = await owner`insert into projects (tenant_id, name) values (${cidA}, 'P-A1') returning id`;
      projectAId = projectA.id as string;
    } finally {
      await owner.end();
    }
    outsiderToken = await login('outsider@tenant-a.test');
    crossTenantToken = await login('cross@tenant-b.test');

    // 邀请三客户角色（真实成员链路）：PM 先按 key user 邀请，再升级为 customer_pm
    pmToken = await inviteMember(projectAId, {
      email: 'pm@tenant-a.test',
      role: 'customer_key_user',
    });
    const ownerUp = connectOwner();
    try {
      await ownerUp`update users set role = 'customer_pm' where email = 'pm@tenant-a.test'`;
    } finally {
      await ownerUp.end();
    }
    pmToken = await login('pm@tenant-a.test'); // 角色在登录时签发进 JWT，升级后须重新登录
    keyUserToken = await inviteMember(projectAId, {
      email: 'ku@tenant-a.test',
      role: 'customer_key_user',
    });
    regularUserToken = await inviteMember(projectAId, {
      email: 'ru@tenant-a.test',
      role: 'customer_user',
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('验收①-1：标准模板建阶段 → 项目内追加（sortOrder 递增）', async () => {
    // 模板列表（Phase 1 内置常量，项目成员可读）
    const tpl = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/stages/templates`,
      headers: { authorization: `Bearer ${pmToken}` }, // 客户也可读模板
    });
    expect(tpl.statusCode).toBe(200);
    const tplParsed = StageTemplatesResponseSchema.safeParse(tpl.json());
    expect(tplParsed.success).toBe(true);
    const keys = tplParsed.data!.templates.map((t) => t.key);
    expect(keys).toContain('requirements');
    expect(keys).toContain('go_live');

    // 从模板创建（名称可改）
    const a = await createStage(internalToken, {
      templateKey: 'requirements',
      name: '需求分析（v1 范围）',
      description: '调研业务流程',
    });
    expect(a.status).toBe(201);
    expect(a.stage!.templateKey).toBe('requirements');
    expect(a.stage!.sortOrder).toBe(0);
    expect(a.stage!.status).toBe('not_started');

    // 自定义阶段（无模板）+ 模板阶段，sortOrder 递增
    const b = await createStage(internalToken, { name: '自定义准备' });
    expect(b.status).toBe(201);
    expect(b.stage!.templateKey).toBeNull();
    expect(b.stage!.sortOrder).toBe(1);
    stageBId = b.stage!.id;
    const c = await createStage(internalToken, { templateKey: 'go_live', name: '上线支持' });
    expect(c.status).toBe(201);
    expect(c.stage!.sortOrder).toBe(2);
    stageCId = c.stage!.id;
  });

  it('验收①-2：排序调整 + 状态流转（自由四态）+ 删除', async () => {
    // 重排 [C, B, A] → 顺序生效
    const list = await listStages(internalToken);
    const [a] = list.stages.filter((s) => s.sortOrder === 0);
    const reorder = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectAId}/stages/reorder`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { stageIds: [stageCId, stageBId, a.id] },
    });
    expect(reorder.statusCode).toBe(200);
    const reordered = StagesListResponseSchema.safeParse(reorder.json());
    expect(reordered.success).toBe(true);
    expect(reordered.data!.stages.map((s) => s.id)).toEqual([stageCId, stageBId, a.id]);
    // 含无效 id → 400
    const bogus = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectAId}/stages/reorder`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { stageIds: [stageCId, '00000000-0000-0000-0000-000000000000'] },
    });
    expect(bogus.statusCode).toBe(400);

    // 状态流转：未开始 → 进行中 → 已暂停 → 已完成（自由，无严格状态机）
    const toInProgress = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectAId}/stages/${stageCId}`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { status: 'in_progress' },
    });
    expect(toInProgress.statusCode).toBe(200);
    expect(StageResponseSchema.safeParse(toInProgress.json()).data!.stage.status).toBe('in_progress');
    const toPaused = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectAId}/stages/${stageCId}`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { status: 'paused' },
    });
    expect(toPaused.statusCode).toBe(200);
    expect(StageResponseSchema.safeParse(toPaused.json()).data!.stage.status).toBe('paused');
    const toCompleted = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectAId}/stages/${stageCId}`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { status: 'completed' },
    });
    expect(toCompleted.statusCode).toBe(200);
    // 非法状态 → 400（契约）
    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectAId}/stages/${stageCId}`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { status: 'done' },
    });
    expect(invalid.statusCode).toBe(400);

    // 删除阶段 A（→ 204）
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectAId}/stages/${a.id}`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(del.statusCode).toBe(204);
    const after = await listStages(internalToken);
    expect(after.stages).toHaveLength(2);
    expect(after.stages.map((s) => s.id)).not.toContain(a.id);
  });

  it('验收②：风险创建、关联阶段、状态与负责人更新', async () => {
    // 负责人候选（内部用户）
    const owners = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/risks/assignees`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(owners.statusCode).toBe(200);
    expect(RiskOwnersListResponseSchema.safeParse(owners.json()).success).toBe(true);

    // 创建风险：关联阶段 B + 负责人 = internal
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/risks`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: {
        description: '关键业务数据缺失，影响上线',
        level: 'high',
        stageId: stageBId,
        ownerId: internalUserId,
      },
    });
    expect(create.statusCode).toBe(201);
    const riskParsed = RiskResponseSchema.safeParse(create.json());
    expect(riskParsed.success).toBe(true);
    const risk = riskParsed.data!.risk;
    expect(risk.level).toBe('high');
    expect(risk.status).toBe('open'); // 默认未处理
    expect(risk.stageId).toBe(stageBId);
    expect(risk.stageName).toBe('自定义准备');
    expect(risk.ownerId).toBe(internalUserId);
    expect(risk.ownerName).toBeTruthy();

    // 更新：等级/状态/负责人
    const update = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectAId}/risks/${risk.id}`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { level: 'medium', status: 'in_progress' },
    });
    expect(update.statusCode).toBe(200);
    const updated = RiskResponseSchema.safeParse(update.json()).data!.risk;
    expect(updated.level).toBe('medium');
    expect(updated.status).toBe('in_progress');

    // 校验：关联阶段须属于本项目；负责人须内部用户
    const badStage = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectAId}/risks/${risk.id}`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { stageId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(badStage.statusCode).toBe(400);
    // 负责人 = 客户 PM → 400（负责人仅限内部）
    const customerOwnerId = await (async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'pm@tenant-a.test', password },
      });
      const body = res.json() as { user: { id: string } };
      return body.user.id;
    })();
    const badOwner = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectAId}/risks/${risk.id}`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { ownerId: customerOwnerId },
    });
    expect(badOwner.statusCode).toBe(400);

    // null 清空关联阶段（阶段删除前的解绑能力）
    const clear = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectAId}/risks/${risk.id}`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { stageId: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(RiskResponseSchema.safeParse(clear.json()).data!.risk.stageId).toBeNull();
  });

  it('阶段删除后关联风险保留（FK set null，stageName 置空）', async () => {
    // 再建一个风险关联 stageC，删除 stageC → 风险仍在、stageId/stageName 为 null
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/risks`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { description: '上线切换窗口风险', level: 'low', stageId: stageCId },
    });
    expect(create.statusCode).toBe(201);
    const riskId = (RiskResponseSchema.safeParse(create.json()).data!.risk).id;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectAId}/stages/${stageCId}`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(del.statusCode).toBe(204);
    const risks = await listRisks(internalToken);
    const kept = risks.risks.find((r) => r.id === riskId);
    expect(kept).toBeTruthy();
    expect(kept!.stageId).toBeNull();
    expect(kept!.stageName).toBeNull();

    // 删除风险 → 204
    const delRisk = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectAId}/risks/${riskId}`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(delRisk.statusCode).toBe(204);
    const after = await listRisks(internalToken);
    expect(after.risks.find((r) => r.id === riskId)).toBeUndefined();
  });

  it('验收③：客户用户只读——查看 200，增删改/排序/负责人 403', async () => {
    for (const token of [pmToken, keyUserToken, regularUserToken]) {
      const stages = await listStages(token);
      expect(stages.status).toBe(200);
      expect(stages.stages.length).toBeGreaterThan(0);
      const risks = await listRisks(token);
      expect(risks.status).toBe(200);

      // 写操作全部 403
      const create = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectAId}/stages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: '越权阶段' },
      });
      expect(create.statusCode).toBe(403);
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectAId}/stages/${stageBId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'in_progress' },
      });
      expect(patch.statusCode).toBe(403);
      const reorder = await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectAId}/stages/reorder`,
        headers: { authorization: `Bearer ${token}` },
        payload: { stageIds: [stageBId] },
      });
      expect(reorder.statusCode).toBe(403);
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/projects/${projectAId}/stages/${stageBId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(403);
      const riskCreate = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectAId}/risks`,
        headers: { authorization: `Bearer ${token}` },
        payload: { description: '越权风险', level: 'high' },
      });
      expect(riskCreate.statusCode).toBe(403);
    }
  });

  it('成员边界：同租户非成员 403；跨租户 404（防探测）', async () => {
    expect((await listStages(outsiderToken)).status).toBe(403);
    expect((await listRisks(outsiderToken)).status).toBe(403);
    const crossStages = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/stages`,
      headers: { authorization: `Bearer ${crossTenantToken}` },
    });
    expect(crossStages.statusCode).toBe(404);
    const crossRisks = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/risks`,
      headers: { authorization: `Bearer ${crossTenantToken}` },
    });
    expect(crossRisks.statusCode).toBe(404);
  });

  it('审计：stage.create/update/delete/reorder、risk.create/update/delete 落 audit_logs', async () => {
    const owner = connectOwner();
    try {
      const creates = await owner`select metadata from audit_logs where action = 'stage.create'`;
      expect(creates.length).toBeGreaterThanOrEqual(3); // 三个阶段
      const updates = await owner`select metadata from audit_logs where action = 'stage.update'`;
      expect(updates.length).toBeGreaterThanOrEqual(3); // 三次流转
      const deletes = await owner`select metadata from audit_logs where action = 'stage.delete'`;
      expect(deletes.length).toBeGreaterThanOrEqual(2); // 阶段 A + 阶段 C
      const reorders = await owner`select metadata from audit_logs where action = 'stage.reorder'`;
      expect(reorders.length).toBeGreaterThanOrEqual(1);
      const reorderMeta = JSON.parse(reorders[0].metadata as string) as {
        count: number;
      };
      expect(reorderMeta.count).toBe(3);
      const riskCreates = await owner`select metadata from audit_logs where action = 'risk.create'`;
      expect(riskCreates.length).toBeGreaterThanOrEqual(2);
      const riskUpdates = await owner`select metadata from audit_logs where action = 'risk.update'`;
      expect(riskUpdates.length).toBeGreaterThanOrEqual(2); // 等级/状态更新 + 清空关联阶段
      const riskDeletes = await owner`select metadata from audit_logs where action = 'risk.delete'`;
      expect(riskDeletes.length).toBeGreaterThanOrEqual(1);
    } finally {
      await owner.end();
    }
  });
});
