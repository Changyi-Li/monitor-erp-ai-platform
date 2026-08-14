import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  BlueprintGetResponseSchema,
  BlueprintPublishResponseSchema,
  BlueprintUpdateResponseSchema,
  BlueprintVersionGetResponseSchema,
  BlueprintVersionsListResponseSchema,
  MemberInviteResponseSchema,
  SetPasswordResponseSchema,
  type Blueprint,
  type BlueprintVersion,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * 蓝图 e2e（issue #16 验收）：
 * - ① 上传 draw.io + 结构化内容 → 生成 v1 快照；重复创建 409
 * - ② 编辑 → 发布新版本 → 版本历史列表（v1/v2…）可回看差异
 * - ③ 历史版本可回看、可下载原文件（字节一致；换文件后版本间文件隔离）
 * - ④ 客户用户只读：查看 200，创建/编辑/发布 403；非成员 403；跨租户 404
 * - 审计：blueprint.create/update/publish 落 audit_logs（metadata from/to）
 */
describe('Blueprints e2e：版本快照链路与内部维护边界', () => {
  let app: NestFastifyApplication;

  const password = 'password123';
  const drawioV1 = '<mxfile><diagram name="v1">A</diagram></mxfile>';
  const drawioV2 = '<mxfile><diagram name="v2">B-修改版</diagram></mxfile>';

  let internalToken: string;
  let pmToken: string;
  let keyUserToken: string;
  let regularUserToken: string;
  let outsiderToken: string; // 同租户非项目成员
  let crossTenantToken: string; // 另一客户（跨租户 → 404 防探测）
  let projectAId: string;
  let blueprintId: string;

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

  function drawioUpload(xml: string) {
    return {
      name: '蓝图.drawio',
      contentType: 'application/xml',
      base64: Buffer.from(xml, 'utf8').toString('base64'),
    };
  }

  const uploadBody = (xml: string, extra: Record<string, unknown> = {}) => ({
    drawio: drawioUpload(xml),
    businessRequirements: '业务需求',
    moduleScope: '模块范围',
    configNotes: '配置说明',
    processDescription: '流程描述',
    ...extra,
  });

  async function getBlueprint(token: string): Promise<{ status: number; blueprint: Blueprint | null }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/blueprints`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.statusCode !== 200) {
      return { status: res.statusCode, blueprint: null };
    }
    const parsed = BlueprintGetResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, blueprint: parsed.data!.blueprint };
  }

  async function createBlueprint(
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; blueprint: Blueprint | null; version: BlueprintVersion | null }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/blueprints`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    if (res.statusCode !== 201) {
      return { status: res.statusCode, blueprint: null, version: null };
    }
    const parsed = BlueprintPublishResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, blueprint: parsed.data!.blueprint, version: parsed.data!.version };
  }

  async function patchBlueprint(
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; blueprint: Blueprint | null }> {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectAId}/blueprints`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    if (res.statusCode !== 200) {
      return { status: res.statusCode, blueprint: null };
    }
    const parsed = BlueprintUpdateResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, blueprint: parsed.data!.blueprint };
  }

  async function publishBlueprint(token: string): Promise<{ status: number; version: BlueprintVersion | null }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/blueprints/publish`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.statusCode !== 200) {
      return { status: res.statusCode, version: null };
    }
    const parsed = BlueprintPublishResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, version: parsed.data!.version };
  }

  async function listVersions(token: string): Promise<{ status: number; versions: BlueprintVersion[] }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/blueprints/versions`,
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.statusCode !== 200) {
      return { status: res.statusCode, versions: [] };
    }
    const parsed = BlueprintVersionsListResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, versions: parsed.data!.versions };
  }

  async function getVersion(token: string, version: number): Promise<{ status: number; body: unknown }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/blueprints/versions/${version}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: res.json() };
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

  it('验收①：内部上传 draw.io + 结构化内容 → 生成 v1 快照', async () => {
    const r = await createBlueprint(internalToken, uploadBody(drawioV1));
    expect(r.status).toBe(201);
    expect(r.blueprint!.latestVersion).toBe(1);
    expect(r.blueprint!.drawio!.size).toBe(Buffer.byteLength(drawioV1, 'utf8'));
    expect(r.version!.version).toBe(1);
    expect(r.version!.businessRequirements).toBe('业务需求');
    expect(r.version!.publishedBy!.displayName).toBe('internal');
    blueprintId = r.blueprint!.id;
  });

  it('重复创建 → 409；缺 drawio → 400（契约）', async () => {
    const dup = await createBlueprint(internalToken, uploadBody(drawioV1));
    expect(dup.status).toBe(409);
    const noFile = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectAId}/blueprints`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { businessRequirements: '无文件' },
    });
    expect(noFile.statusCode).toBe(400);
  });

  it('验收④：客户用户只读——创建/编辑/发布 403，查看 200', async () => {
    for (const token of [pmToken, keyUserToken, regularUserToken]) {
      expect((await createBlueprint(token, uploadBody(drawioV1))).status).toBe(403);
      expect((await patchBlueprint(token, { businessRequirements: '越权' })).status).toBe(403);
      expect((await publishBlueprint(token)).status).toBe(403);
    }
    for (const token of [pmToken, keyUserToken, regularUserToken]) {
      const r = await getBlueprint(token);
      expect(r.status).toBe(200);
      expect(r.blueprint!.id).toBe(blueprintId);
    }
  });

  it('成员边界：同租户非成员 403；跨租户 404（防探测）', async () => {
    expect((await getBlueprint(outsiderToken)).status).toBe(403);
    expect((await getBlueprint(crossTenantToken)).status).toBe(404);
    expect((await listVersions(crossTenantToken)).status).toBe(404);
  });

  it('验收②：编辑 → 发布新版本 → 版本历史 v1/v2 可回看差异', async () => {
    const edit = await patchBlueprint(internalToken, { businessRequirements: '业务需求 v2' });
    expect(edit.status).toBe(200);
    expect(edit.blueprint!.latestVersion).toBe(1); // 编辑不产生版本，latest 不变

    const pub = await publishBlueprint(internalToken);
    expect(pub.status).toBe(200);
    expect(pub.version!.version).toBe(2);
    expect(pub.version!.businessRequirements).toBe('业务需求 v2');
    expect(pub.version!.publishedBy!.id).toBeTruthy();

    const versions = await listVersions(pmToken); // 客户可看历史
    expect(versions.status).toBe(200);
    expect(versions.versions).toHaveLength(2);
    expect(versions.versions.map((v) => v.version)).toEqual([1, 2]);

    // 回看差异：v1 旧内容、v2 新内容（快照冻结）
    const v1 = await getVersion(internalToken, 1);
    expect(v1.status).toBe(200);
    const parsed1 = BlueprintVersionGetResponseSchema.safeParse(v1.body);
    expect(parsed1.success).toBe(true);
    expect(parsed1.data!.version.businessRequirements).toBe('业务需求');
    const v2 = await getVersion(internalToken, 2);
    const parsed2 = BlueprintVersionGetResponseSchema.safeParse(v2.body);
    expect(parsed2.success).toBe(true);
    expect(parsed2.data!.version.businessRequirements).toBe('业务需求 v2');
  });

  it('验收③：历史版本可下载原文件（字节一致 + 版本间文件隔离）', async () => {
    // v1/v2 文件均为初始 drawio（PATCH 未换文件）
    for (const version of [1, 2]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/blueprints/versions/${version}/file`,
        headers: { authorization: `Bearer ${pmToken}` }, // 客户可下载
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/xml');
      expect(res.headers['content-disposition']).toContain('filename*=UTF-8');
      expect(res.rawPayload.toString('utf8')).toBe(drawioV1);
    }
    // 换文件再发布 v3：v3 为新字节，v1 仍是旧字节
    const edit = await patchBlueprint(internalToken, { drawio: drawioUpload(drawioV2) });
    expect(edit.status).toBe(200);
    expect(edit.blueprint!.drawio!.size).toBe(Buffer.byteLength(drawioV2, 'utf8'));
    const pub = await publishBlueprint(internalToken);
    expect(pub.status).toBe(200);
    expect(pub.version!.version).toBe(3);
    const v3 = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/blueprints/versions/3/file`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(v3.statusCode).toBe(200);
    expect(v3.rawPayload.toString('utf8')).toBe(drawioV2);
    const v1again = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectAId}/blueprints/versions/1/file`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(v1again.rawPayload.toString('utf8')).toBe(drawioV1); // 历史快照不受新发布影响
  });

  it('版本参数校验：非正数 400、不存在的版本 404、未创建蓝图的版本列表为空', async () => {
    expect((await getVersion(internalToken, 0)).status).toBe(400);
    expect((await getVersion(internalToken, 99)).status).toBe(404);
    // 同租户新项目（未创建蓝图）→ 版本列表空数组
    const ownerEmpty = connectOwner();
    let emptyProjectId: string;
    try {
      const [emptyProject] = await ownerEmpty`
        insert into projects (tenant_id, name) select tenant_id, 'P-empty' from blueprints where id = ${blueprintId} returning id`;
      emptyProjectId = emptyProject.id as string;
    } finally {
      await ownerEmpty.end();
    }
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${emptyProjectId}/blueprints/versions`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(BlueprintVersionsListResponseSchema.safeParse(res.json()).data!.versions).toEqual([]);
  });

  it('审计：blueprint.create/update/publish 落 audit_logs（publish 带 from/to）', async () => {
    const owner = connectOwner();
    try {
      const creates = await owner`select metadata from audit_logs where action = 'blueprint.create'`;
      expect(creates.length).toBeGreaterThanOrEqual(1);
      const updates = await owner`select metadata from audit_logs where action = 'blueprint.update'`;
      expect(updates.length).toBeGreaterThanOrEqual(2); // 两次 PATCH
      const publishes = await owner`select metadata from audit_logs where action = 'blueprint.publish' order by created_at`;
      expect(publishes.length).toBeGreaterThanOrEqual(2); // 两次发布（v2/v3）
      // postgres.js 读 jsonb 为字符串，断言前 JSON.parse
      const m2 = JSON.parse(publishes[0].metadata as string) as { fromVersion: number; toVersion: number };
      expect(m2.fromVersion).toBe(1);
      expect(m2.toVersion).toBe(2);
      const m3 = JSON.parse(publishes[1].metadata as string) as { fromVersion: number; toVersion: number };
      expect(m3.fromVersion).toBe(2);
      expect(m3.toVersion).toBe(3);
    } finally {
      await owner.end();
    }
  });
});
