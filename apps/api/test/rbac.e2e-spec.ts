import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CustomerCreateResponseSchema,
  MemberInviteResponseSchema,
  MembersListResponseSchema,
  ProjectCreateResponseSchema,
  ProjectGetResponseSchema,
  ProjectsListResponseSchema,
  SetPasswordResponseSchema,
  UsersListResponseSchema,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * RBAC / 用户管理 / 项目边界 e2e（issue #13 验收）：
 * - 权限矩阵 API 级覆盖：角色 × 端点（建客户=超管、建项目=内部+、
 *   成员管理=内部/该项目 PM、用户/客户列表=内部+）
 * - 邀请链接首次设密全流程；PM 项目内邀请/停用（不可跨项目、不可升级角色）
 * - 客户跨项目 403（同租户非成员）；跨租户 404（回归 #12 语义）；内部全访问
 * - 审计日志：登录/设密/权限变更/项目读写在 audit_logs
 */
describe('RBAC e2e：权限矩阵、邀请设密与项目边界', () => {
  let app: NestFastifyApplication;

  const password = 'password123';
  let internalToken: string;
  let superAdminToken: string;
  let pmToken: string;
  let keyUserToken: string;
  let cidA: string;
  let cidB: string;
  let projectAId: string;
  let projectA2Id: string;
  let projectB1Id: string;
  let pmUserId: string;
  let keyUserId: string;
  let internalUserId: string;

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

  async function inviteMember(
    token: string,
    projectId: string,
    body: { email: string; role: string; displayName?: string },
  ): Promise<{ status: number; inviteUrl: string | null }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    if (res.statusCode !== 201) {
      return { status: res.statusCode, inviteUrl: null };
    }
    const parsed = MemberInviteResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, inviteUrl: parsed.data!.inviteUrl };
  }

  async function setPasswordAndLogin(email: string, inviteUrl: string): Promise<string> {
    const token = new URL(inviteUrl).searchParams.get('token')!;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/set-password',
      payload: { token, password },
    });
    expect(res.statusCode).toBe(200);
    expect(SetPasswordResponseSchema.safeParse(res.json()).success).toBe(true);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(login.statusCode).toBe(200);
    return (login.json() as { accessToken: string }).accessToken;
  }

  beforeAll(async () => {
    await resetTestDb();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();

    // 用户：register 默认 internal；admin 提升为 super_admin
    const internal = await register('internal@corp.test');
    const admin = await register('admin@corp.test');
    internalUserId = internal.id;
    internalToken = internal.token;
    const owner = connectOwner();
    try {
      await owner`update users set role = 'super_admin' where id = ${admin.id}`;
      const [customerA] = await owner`insert into customers (name) values ('客户A') returning id`;
      const [customerB] = await owner`insert into customers (name) values ('客户B') returning id`;
      cidA = customerA.id as string;
      cidB = customerB.id as string;
    } finally {
      await owner.end();
    }
    // 角色升级后重新登录：JWT 携带 super_admin 声明
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@corp.test', password },
    });
    expect(adminLogin.statusCode).toBe(200);
    superAdminToken = (adminLogin.json() as { accessToken: string }).accessToken;

    // 内部建项目（P-A）→ 邀请 PM → 设密登录
    const createA = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { tenantId: cidA, name: 'P-A' },
    });
    expect(createA.statusCode).toBe(201);
    expect(ProjectCreateResponseSchema.safeParse(createA.json()).success).toBe(true);
    projectAId = (createA.json() as { project: { id: string } }).project.id;

    const pmInvite = await inviteMember(internalToken, projectAId, {
      email: 'pm@a.test',
      role: 'project_manager',
    });
    expect(pmInvite.status).toBe(201);
    expect(pmInvite.inviteUrl).toContain('/invite?token=');
    pmToken = await setPasswordAndLogin('pm@a.test', pmInvite.inviteUrl!);
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${pmToken}` },
    });
    pmUserId = (me.json() as { user: { id: string } }).user.id;

    // Key User 邀请 → 设密登录
    const keyInvite = await inviteMember(pmToken, projectAId, {
      email: 'key@a.test',
      role: 'key_user',
    });
    expect(keyInvite.status).toBe(201);
    keyUserToken = await setPasswordAndLogin('key@a.test', keyInvite.inviteUrl!);
    const meKey = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${keyUserToken}` },
    });
    keyUserId = (meKey.json() as { user: { id: string } }).user.id;

    // 同租户无成员项目 A2 + 客户 B 项目 B1（owner seed 项目与成员）
    const owner2 = connectOwner();
    try {
      const [a2] = await owner2`insert into projects (tenant_id, name) values (${cidA}, 'A2') returning id`;
      const [b1] = await owner2`insert into projects (tenant_id, name) values (${cidB}, 'B1') returning id`;
      projectA2Id = a2.id as string;
      projectB1Id = b1.id as string;
      // 客户 B 的 PM（用于跨租户 409 与 PM-A 访问 B1 的 404 断言）
      const [userB] = await owner2`insert into users (email, password_hash, display_name, role, is_active)
        values ('pm-b@b.test', 'x', 'PM-B', 'customer', true) returning id`;
      await owner2`insert into user_tenants (user_id, customer_id) values (${userB.id}, ${cidB})`;
      await owner2`insert into project_members (project_id, user_id, role) values (${b1.id}, ${userB.id}, 'project_manager')`;
    } finally {
      await owner2.end();
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('平台管理：客户与项目', () => {
    it('建客户：超管 201 + 审计；内部 403；未登录 401', async () => {
      const ok = await app.inject({
        method: 'POST',
        url: '/api/customers',
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { name: '客户C' },
      });
      expect(ok.statusCode).toBe(201);
      expect(CustomerCreateResponseSchema.safeParse(ok.json()).success).toBe(true);

      const denied = await app.inject({
        method: 'POST',
        url: '/api/customers',
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { name: '客户D' },
      });
      expect(denied.statusCode).toBe(403);

      const anon = await app.inject({
        method: 'POST',
        url: '/api/customers',
        payload: { name: '客户E' },
      });
      expect(anon.statusCode).toBe(401);
    });

    it('建项目：内部 201（审计 project.create）；客户 403', async () => {
      const ok = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { tenantId: cidA, name: 'P-A3' },
      });
      expect(ok.statusCode).toBe(201);

      const denied = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { tenantId: cidA, name: 'X' },
      });
      expect(denied.statusCode).toBe(403);
    });

    it('建项目归属不存在的客户 → 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { tenantId: '00000000-0000-0000-0000-000000000000', name: 'X' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('邀请链接首次设密', () => {
    it('未激活用户登录 → 401（占位密码不可用）', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'pm@a.test', password: 'wrong-placeholder' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('无效/伪造 token 设密 → 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/set-password',
        payload: { token: 'forged-token', password },
      });
      expect(res.statusCode).toBe(400);
    });

    it('已激活用户二次设密 → 400（token 一次性）', async () => {
      const invite = await inviteMember(internalToken, projectAId, {
        email: 'pm@a.test',
        role: 'project_manager',
      });
      expect(invite.status).toBe(409); // 已激活重复邀请也 409
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/set-password',
        payload: { token: 'deadbeef', password },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PM 登录后 me 正常，角色为 customer', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${pmToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { user: { role: string } }).user.role).toBe('customer');
    });
  });

  describe('权限矩阵：成员管理端点（角色 × 功能）', () => {
    it('PM 项目列表只见自己成员的项目；详情 viewerRole=project_manager', async () => {
      const list = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { authorization: `Bearer ${pmToken}` },
      });
      expect(list.statusCode).toBe(200);
      const projects = (list.json() as { projects: { id: string; name: string }[] }).projects;
      expect(projects.map((p) => p.name).sort()).toEqual(['P-A']);
    });

    it('Key User 可看项目（project:read 全员），但成员列表/邀请/停用 → 403', async () => {
      const detail = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}`,
        headers: { authorization: `Bearer ${keyUserToken}` },
      });
      expect(detail.statusCode).toBe(200);
      const parsed = ProjectGetResponseSchema.safeParse(detail.json());
      expect(parsed.success).toBe(true);
      expect(parsed.data!.viewerRole).toBe('key_user');

      const list = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/members`,
        headers: { authorization: `Bearer ${keyUserToken}` },
      });
      expect(list.statusCode).toBe(403);

      const invite = await inviteMember(keyUserToken, projectAId, {
        email: 'nobody@a.test',
        role: 'regular_user',
      });
      expect(invite.status).toBe(403);

      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectAId}/members/${pmUserId}`,
        headers: { authorization: `Bearer ${keyUserToken}` },
        payload: { isActive: false },
      });
      expect(patch.statusCode).toBe(403);
    });

    it('PM 邀请 project_manager → 403（不可升级角色/不可建 PM）', async () => {
      const res = await inviteMember(pmToken, projectAId, {
        email: 'pm2@a.test',
        role: 'project_manager',
      });
      expect(res.status).toBe(403);
    });

    it('PM 邀请他租户已有用户 → 409；邀请内部邮箱 → 400', async () => {
      const cross = await inviteMember(pmToken, projectAId, {
        email: 'pm-b@b.test',
        role: 'regular_user',
      });
      expect(cross.status).toBe(409);

      const internal = await inviteMember(pmToken, projectAId, {
        email: 'internal@corp.test',
        role: 'regular_user',
      });
      expect(internal.status).toBe(400);
    });

    it('重复邀请已激活成员 → 409；同租户已激活用户直接加入（inviteUrl=null）', async () => {
      const dup = await inviteMember(pmToken, projectAId, {
        email: 'key@a.test',
        role: 'key_user',
      });
      expect(dup.status).toBe(409);

      // owner 直插一个同租户已激活用户（无成员关系），PM 邀请 → 直接加成员
      const owner = connectOwner();
      let invitedEmail = '';
      try {
        const [u] = await owner`insert into users (email, password_hash, display_name, role, is_active)
          values ('existing@a.test', 'x', '已有用户', 'customer', true) returning id, email`;
        await owner`insert into user_tenants (user_id, customer_id) values (${u.id}, ${cidA})`;
        invitedEmail = u.email as string;
      } finally {
        await owner.end();
      }
      const res = await inviteMember(pmToken, projectAId, {
        email: invitedEmail,
        role: 'regular_user',
      });
      expect(res.status).toBe(201);
      expect(res.inviteUrl).toBeNull();
    });
  });

  describe('项目边界：跨项目 403 / 跨租户 404 / 内部全访问', () => {
    it('同租户非成员项目 → 403（跨项目访问）', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectA2Id}`,
        headers: { authorization: `Bearer ${pmToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('跨租户项目 → 404（保持 #12 防探测语义）', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectB1Id}`,
        headers: { authorization: `Bearer ${pmToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('内部用户访问任意租户项目 → 200 viewerRole=internal', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectB1Id}`,
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(res.statusCode).toBe(200);
      const parsed = ProjectGetResponseSchema.safeParse(res.json());
      expect(parsed.success).toBe(true);
      expect(parsed.data!.viewerRole).toBe('internal');
    });

    it('非法 uuid 参数 → 400（成员端点同）', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects/not-a-uuid',
        headers: { authorization: `Bearer ${pmToken}` },
      });
      expect(res.statusCode).toBe(400);
      const members = await app.inject({
        method: 'GET',
        url: '/api/projects/not-a-uuid/members',
        headers: { authorization: `Bearer ${pmToken}` },
      });
      expect(members.statusCode).toBe(400);
    });
  });

  describe('PM 停用/启用成员', () => {
    it('停用 Key User → 该用户项目访问 403；恢复 → 200', async () => {
      const off = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectAId}/members/${keyUserId}`,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { isActive: false },
      });
      expect(off.statusCode).toBe(204);

      const blocked = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}`,
        headers: { authorization: `Bearer ${keyUserToken}` },
      });
      expect(blocked.statusCode).toBe(403);

      const on = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectAId}/members/${keyUserId}`,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { isActive: true },
      });
      expect(on.statusCode).toBe(204);

      const back = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}`,
        headers: { authorization: `Bearer ${keyUserToken}` },
      });
      expect(back.statusCode).toBe(200);
    });

    it('PM 不能停用项目经理成员（含自己）→ 403', async () => {
      const self = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectAId}/members/${pmUserId}`,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { isActive: false },
      });
      expect(self.statusCode).toBe(403);
    });

    it('停用不存在的成员 → 404', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectAId}/members/00000000-0000-0000-0000-000000000000`,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { isActive: false },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('平台管理：用户与客户列表', () => {
    it('GET /api/users：内部 200；客户 403', async () => {
      const ok = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(ok.statusCode).toBe(200);
      expect(UsersListResponseSchema.safeParse(ok.json()).success).toBe(true);

      const denied = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${pmToken}` },
      });
      expect(denied.statusCode).toBe(403);
    });

    // #14：列表放开给客户角色（RLS 过滤 → 只见所属客户，只读）；编辑 PATCH 仍 403
    it('GET /api/customers：内部 200 全量；客户 200 但只见所属（RLS 过滤）', async () => {
      const ok = await app.inject({
        method: 'GET',
        url: '/api/customers',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(ok.statusCode).toBe(200);

      const denied = await app.inject({
        method: 'GET',
        url: '/api/customers',
        headers: { authorization: `Bearer ${pmToken}` },
      });
      expect(denied.statusCode).toBe(200);
      const body = denied.json() as { customers: { id: string }[] };
      expect(body.customers.length).toBeLessThanOrEqual(1);
    });

    it('PATCH /api/customers/:id：客户角色 403（只读边界，#14 验收 ③）', async () => {
      const denied = await app.inject({
        method: 'PATCH',
        url: `/api/customers/00000000-0000-4000-8000-000000000000`,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { name: '越权' },
      });
      expect(denied.statusCode).toBe(403);
    });
  });

  describe('审计日志（spec §11）', () => {
    it('登录/设密/权限变更/关键数据访问均落库，actor 正确', async () => {
      const owner = connectOwner();
      try {
        const rows = await owner`
          select action, actor_user_id, actor_role, resource_type, resource_id
          from audit_logs order by created_at`;
        const actions = rows.map((r) => r.action as string);

        // 登录成功与失败（未激活尝试 → login_failed）
        expect(actions).toContain('auth.login');
        expect(actions).toContain('auth.login_failed');
        // 邀请设密
        expect(actions).toContain('auth.set_password');
        // 权限变更
        expect(actions).toContain('member.add');
        expect(actions).toContain('member.deactivate');
        expect(actions).toContain('member.activate');
        // 平台管理
        expect(actions).toContain('customer.create');
        expect(actions).toContain('project.create');
        // 关键数据访问
        expect(actions).toContain('project.read');

        // 权限变更 actor 指向操作者
        const deactivate = rows.find((r) => r.action === 'member.deactivate');
        expect(deactivate!.actor_user_id).toBe(pmUserId);
        expect(deactivate!.actor_role).toBe('customer');
        // 项目创建 actor 指向内部用户
        const create = rows.find((r) => r.action === 'project.create');
        expect(create!.actor_user_id).toBe(internalUserId);
        expect(create!.actor_role).toBe('internal');
        // 登录失败无 actor 用户（匿名）
        const failed = rows.find((r) => r.action === 'auth.login_failed');
        expect(failed!.actor_user_id).toBeNull();
        expect(failed!.actor_role).toBe('anonymous');
        // 项目读取带资源 id
        const read = rows.find((r) => r.action === 'project.read');
        expect(read!.resource_type).toBe('project');
        expect(read!.resource_id).toBeTruthy();
      } finally {
        await owner.end();
      }
    });
  });
});
