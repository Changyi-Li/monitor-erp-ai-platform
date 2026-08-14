import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CreateUserResponseSchema,
  CustomerCreateResponseSchema,
  MemberInviteResponseSchema,
  MembersListResponseSchema,
  ProjectCreateResponseSchema,
  ProjectGetResponseSchema,
  ProjectsListResponseSchema,
  ResetUserPasswordResponseSchema,
  SetPasswordResponseSchema,
  UpdateUserResponseSchema,
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
      role: 'customer_key_user',
    });
    expect(pmInvite.status).toBe(201);
    expect(pmInvite.inviteUrl).toContain('/invite?token=');
    // T2：成员管理权 = 平台角色 customer_pm——升级账号后再激活登录（JWT 携带新角色）
    const ownerUp = connectOwner();
    try {
      await ownerUp`update users set role = 'customer_pm' where email = 'pm@a.test'`;
    } finally {
      await ownerUp.end();
    }
    pmToken = await setPasswordAndLogin('pm@a.test', pmInvite.inviteUrl!);
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${pmToken}` },
    });
    pmUserId = (me.json() as { user: { id: string } }).user.id;

    // Key User 邀请 → 设密登录（customer_key_user 档）
    const keyInvite = await inviteMember(pmToken, projectAId, {
      email: 'key@a.test',
      role: 'customer_key_user',
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
        values ('pm-b@b.test', 'x', 'PM-B', 'customer_pm', true) returning id`;
      await owner2`insert into user_tenants (user_id, customer_id) values (${userB.id}, ${cidB})`;
      await owner2`insert into project_members (project_id, user_id) values (${b1.id}, ${userB.id})`;
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
        payload: { name: '客户C', email: 'contact-c@rbac.test' },
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
        role: 'customer_user',
      });
      expect(invite.status).toBe(409); // 已激活重复邀请也 409
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/set-password',
        payload: { token: 'deadbeef', password },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PM 登录后 me 正常，角色为 customer_pm（T2：管理权 = 平台角色）', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${pmToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { user: { role: string } }).user.role).toBe('customer_pm');
    });
  });

  describe('权限矩阵：成员管理端点（角色 × 功能）', () => {
    it('PM 项目列表只见自己成员的项目；详情 viewerRole=customer_pm', async () => {
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
      expect(parsed.data!.viewerRole).toBe('customer_key_user');

      const list = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/members`,
        headers: { authorization: `Bearer ${keyUserToken}` },
      });
      expect(list.statusCode).toBe(403);

      const invite = await inviteMember(keyUserToken, projectAId, {
        email: 'nobody@a.test',
        role: 'customer_user',
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

    it('PM 邀请 customer_pm 档 → 400（该档只能由建客户/超管产生，契约层拒绝）', async () => {
      const res = await inviteMember(pmToken, projectAId, {
        email: 'pm2@a.test',
        role: 'customer_pm',
      });
      expect(res.status).toBe(400);
    });

    it('PM 邀请他租户已有用户 → 409；邀请内部邮箱 → 400', async () => {
      const cross = await inviteMember(pmToken, projectAId, {
        email: 'pm-b@b.test',
        role: 'customer_user',
      });
      expect(cross.status).toBe(409);

      const internal = await inviteMember(pmToken, projectAId, {
        email: 'internal@corp.test',
        role: 'customer_user',
      });
      expect(internal.status).toBe(400);
    });

    it('重复邀请已激活成员 → 409；同租户已激活用户直接加入（inviteUrl=null）', async () => {
      const dup = await inviteMember(pmToken, projectAId, {
        email: 'key@a.test',
        role: 'customer_key_user',
      });
      expect(dup.status).toBe(409);

      // owner 直插一个同租户已激活用户（无成员关系），PM 邀请 → 直接加成员
      const owner = connectOwner();
      let invitedEmail = '';
      try {
        const [u] = await owner`insert into users (email, password_hash, display_name, role, is_active)
          values ('existing@a.test', 'x', '已有用户', 'customer_user', true) returning id, email`;
        await owner`insert into user_tenants (user_id, customer_id) values (${u.id}, ${cidA})`;
        invitedEmail = u.email as string;
      } finally {
        await owner.end();
      }
      const res = await inviteMember(pmToken, projectAId, {
        email: invitedEmail,
        role: 'customer_user',
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

    // US-3：超管创建内部用户（方法级 @Roles('super_admin') 覆盖类级 super_admin+internal）
    it('POST /api/users：超管 201 且新账号可登录；内部/客户 403；重复邮箱 409；非法角色 400', async () => {
      const createdEmail = 'created@corp.test';
      const ok = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: {
          email: createdEmail,
          password: 'NewPass123',
          displayName: '新建用户',
          role: 'internal',
        },
      });
      expect(ok.statusCode).toBe(201);
      expect(CreateUserResponseSchema.safeParse(ok.json()).success).toBe(true);

      // 描述默认昵称（#37 迭代）：description 初始 = displayName，后续可编辑为不同内容
      expect(ok.json().user.description).toBe('新建用户');

      // 新账号能登录（验证密码哈希与 role 生效）
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: createdEmail, password: 'NewPass123' },
      });
      expect(login.statusCode).toBe(200);

      // internal 建号 → 403（类级守卫被方法级覆盖）
      const deniedInternal = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { email: 'denied@corp.test', password: 'NewPass123', role: 'internal' },
      });
      expect(deniedInternal.statusCode).toBe(403);

      // 客户建号 → 403
      const deniedCustomer = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { email: 'denied2@corp.test', password: 'NewPass123', role: 'internal' },
      });
      expect(deniedCustomer.statusCode).toBe(403);

      // 重复邮箱 → 409
      const dup = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { email: createdEmail, password: 'NewPass123', role: 'super_admin' },
      });
      expect(dup.statusCode).toBe(409);

      // 重复昵称（不同邮箱）→ 409（display_name 唯一，#37 迭代）
      const dupName = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: {
          email: 'dupnick@corp.test',
          password: 'NewPass123',
          displayName: '新建用户',
          role: 'internal',
        },
      });
      expect(dupName.statusCode).toBe(409);

      // 角色只能是 super_admin/internal（客户角色不可经内部建号端点授予）→ 400
      const badRole = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { email: 'badrole@corp.test', password: 'NewPass123', role: 'customer_pm' },
      });
      expect(badRole.statusCode).toBe(400);
    });

    it('创建内部用户落审计 user.create（actor=超管）', async () => {
      const owner = connectOwner();
      try {
        const rows = await owner`
          select action, actor_user_id, actor_role, resource_type, resource_id
          from audit_logs where action = 'user.create' order by created_at desc limit 1`;
        expect(rows.length).toBe(1);
        expect(rows[0].actor_user_id).toBeTruthy();
        expect(rows[0].actor_role).toBe('super_admin');
        expect(rows[0].resource_type).toBe('user');
        expect(rows[0].resource_id).toBeTruthy();
      } finally {
        await owner.end();
      }
    });

    // #37：超管更新用户描述（PATCH /api/users/:id）——更新/清空/校验/权限矩阵/404/400
    it('PATCH /api/users/:id：超管更新描述持久化；内部/客户 403；404；非法 uuid 400；超长 400', async () => {
      // 目标用户：上一条用例创建的 created@corp.test（describe 顺序依赖）
      const list = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      const target = list
        .json()
        .users.find((u: { email: string }) => u.email === 'created@corp.test');
      expect(target).toBeTruthy();

      // 超管更新描述 → 200 + 响应契约通过
      const ok = await app.inject({
        method: 'PATCH',
        url: `/api/users/${target.id}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { description: '总部实施顾问（华东）' },
      });
      expect(ok.statusCode).toBe(200);
      expect(UpdateUserResponseSchema.safeParse(ok.json()).success).toBe(true);
      expect(ok.json().user.description).toBe('总部实施顾问（华东）');

      // 持久化：GET 列表可见
      const relist = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      expect(
        relist.json().users.find((u: { id: string }) => u.id === target.id)?.description,
      ).toBe('总部实施顾问（华东）');

      // null 清空 → 200 + description 回 null
      const clear = await app.inject({
        method: 'PATCH',
        url: `/api/users/${target.id}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { description: null },
      });
      expect(clear.statusCode).toBe(200);
      expect(clear.json().user.description).toBeNull();

      // 超长描述（>35）→ 400（契约 maxlength 35）
      const tooLong = await app.inject({
        method: 'PATCH',
        url: `/api/users/${target.id}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { description: 'x'.repeat(36) },
      });
      expect(tooLong.statusCode).toBe(400);

      // 内部更新 → 403（方法级 @Roles 覆盖类级）
      const deniedInternal = await app.inject({
        method: 'PATCH',
        url: `/api/users/${target.id}`,
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { description: 'x' },
      });
      expect(deniedInternal.statusCode).toBe(403);

      // 客户更新 → 403
      const deniedCustomer = await app.inject({
        method: 'PATCH',
        url: `/api/users/${target.id}`,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { description: 'x' },
      });
      expect(deniedCustomer.statusCode).toBe(403);

      // 用户不存在 → 404
      const missing = await app.inject({
        method: 'PATCH',
        url: '/api/users/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { description: 'x' },
      });
      expect(missing.statusCode).toBe(404);

      // 非法 uuid → 400（避免 22P02 → 500）
      const badId = await app.inject({
        method: 'PATCH',
        url: '/api/users/not-a-uuid',
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { description: 'x' },
      });
      expect(badId.statusCode).toBe(400);
    });

    it('更新用户描述落审计 user.update（actor=超管）', async () => {
      const owner = connectOwner();
      try {
        const rows = await owner`
          select action, actor_user_id, actor_role, resource_type, resource_id, metadata
          from audit_logs where action = 'user.update' order by created_at desc limit 1`;
        expect(rows.length).toBe(1);
        expect(rows[0].actor_user_id).toBeTruthy();
        expect(rows[0].actor_role).toBe('super_admin');
        expect(rows[0].resource_type).toBe('user');
        expect(rows[0].resource_id).toBeTruthy();
      } finally {
        await owner.end();
      }
    });

    // #38：角色页签后端 —— 超管改平台角色持久化 + 权限实际生效（新登录 token 携带新角色声明）
    it('PATCH /api/users/:id 角色：internal→super_admin 持久化，新登录 token 权限生效；改回 internal 列表可见', async () => {
      // 目标用户：前序用例创建的 created@corp.test（describe 顺序依赖）
      const list = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      const target = list
        .json()
        .users.find((u: { email: string }) => u.email === 'created@corp.test');
      expect(target).toBeTruthy();

      // 内部用户 → super_admin
      const promote = await app.inject({
        method: 'PATCH',
        url: `/api/users/${target.id}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { role: 'super_admin' },
      });
      expect(promote.statusCode).toBe(200);
      expect(UpdateUserResponseSchema.safeParse(promote.json()).success).toBe(true);
      expect(promote.json().user.role).toBe('super_admin');

      // 权限变化断言：新登录 JWT 携带 super_admin 声明（me 从 DB 重查 + RolesGuard 校验）
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'created@corp.test', password: 'NewPass123' },
      });
      expect(login.statusCode).toBe(200);
      const promotedToken = (login.json() as { accessToken: string }).accessToken;
      const me = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${promotedToken}` },
      });
      expect((me.json() as { user: { role: string } }).user.role).toBe('super_admin');

      // 新 token 能执行超管专属 PATCH（权限真实生效，非仅声明）
      const canPatch = await app.inject({
        method: 'PATCH',
        url: `/api/users/${target.id}`,
        headers: { authorization: `Bearer ${promotedToken}` },
        payload: { description: '提升后由本人写入占位' },
      });
      expect(canPatch.statusCode).toBe(200);

      // 改回 internal → 200 + 列表持久化可见
      const demote = await app.inject({
        method: 'PATCH',
        url: `/api/users/${target.id}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { role: 'internal' },
      });
      expect(demote.statusCode).toBe(200);
      expect(demote.json().user.role).toBe('internal');
      const relist = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      expect(
        relist.json().users.find((u: { id: string }) => u.id === target.id)?.role,
      ).toBe('internal');
    });

    // #38：角色防护矩阵 —— 非法角色 400 / internal 与客户 403 / 自己 409 / customer 目标 409
    it('PATCH 角色防护：非法角色 400；internal/客户 403；自己 409；customer 目标 409', async () => {
      const list = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      const users = (
        list.json() as { users: { id: string; email: string; role: string }[] }
      ).users;
      const target = users.find((u) => u.email === 'created@corp.test');
      const adminUser = users.find((u) => u.email === 'admin@corp.test');
      const pmUser = users.find((u) => u.email === 'pm@a.test');
      expect(target).toBeTruthy();
      expect(adminUser).toBeTruthy();
      expect(pmUser).toBeTruthy();

      // 非法角色（客户角色不可在此赋值，T3 放开客户三档互调）→ 400
      const badRole = await app.inject({
        method: 'PATCH',
        url: `/api/users/${target.id}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { role: 'customer_pm' },
      });
      expect(badRole.statusCode).toBe(400);

      // internal 改角色 → 403（方法级 @Roles 覆盖类级）
      const deniedInternal = await app.inject({
        method: 'PATCH',
        url: `/api/users/${target.id}`,
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { role: 'super_admin' },
      });
      expect(deniedInternal.statusCode).toBe(403);

      // 客户改角色 → 403
      const deniedCustomer = await app.inject({
        method: 'PATCH',
        url: `/api/users/${target.id}`,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { role: 'super_admin' },
      });
      expect(deniedCustomer.statusCode).toBe(403);

      // 自己改自己 → 409（防最后一名超管降级锁死平台）
      const selfChange = await app.inject({
        method: 'PATCH',
        url: `/api/users/${adminUser.id}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { role: 'internal' },
      });
      expect(selfChange.statusCode).toBe(409);

      // customer 目标改角色 → 409（客户账号走邀请流程创建，不可在此改角色）
      const customerTarget = await app.inject({
        method: 'PATCH',
        url: `/api/users/${pmUser.id}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { role: 'super_admin' },
      });
      expect(customerTarget.statusCode).toBe(409);
    });

    // #38：角色变更落审计 user.update（metadata 含 role 字段）
    it('改角色落审计 user.update（metadata 含 role）', async () => {
      const owner = connectOwner();
      try {
        const rows = await owner`
          select action, actor_role, metadata
          from audit_logs where action = 'user.update' order by created_at desc limit 1`;
        expect(rows.length).toBe(1);
        expect(rows[0].actor_role).toBe('super_admin');
        const metadata = JSON.parse(rows[0].metadata as string) as Record<string, unknown>;
        expect(metadata.role).toBe('internal'); // 最新一条 = 改回 internal 的角色变更
      } finally {
        await owner.end();
      }
    });

    // #39：安全页签后端 —— 重置密码（POST /api/users/:id/reset-password）
    // 权限模型（用户拍板）：任何人可改自己密码；超管可改任何人（含自己）；非超管改别人 → 403
    it('超管重置他人密码：200 契约通过；新密码登录 200、旧密码 401（旧密码即刻失效）', async () => {
      const list = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      const target = list
        .json()
        .users.find((u: { email: string }) => u.email === 'created@corp.test');
      expect(target).toBeTruthy();

      const ok = await app.inject({
        method: 'POST',
        url: `/api/users/${target.id}/reset-password`,
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { password: 'ResetPass456' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ResetUserPasswordResponseSchema.safeParse(ok.json()).success).toBe(true);

      // 新密码可登录（密码实际生效）
      const loginNew = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'created@corp.test', password: 'ResetPass456' },
      });
      expect(loginNew.statusCode).toBe(200);

      // 旧密码失效（#38 用例初始密码 NewPass123）
      const loginOld = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'created@corp.test', password: 'NewPass123' },
      });
      expect(loginOld.statusCode).toBe(401);
    });

    it('internal/customer 改自己密码：200 + 新密码可登录（用户拍板：非超管可改自己）', async () => {
      const list = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      const users = list.json().users as { id: string; email: string }[];
      const internalUser = users.find((u) => u.email === 'internal@corp.test');
      const pmUser = users.find((u) => u.email === 'pm@a.test');
      expect(internalUser).toBeTruthy();
      expect(pmUser).toBeTruthy();

      // internal 改自己 → 200 + 新密码可登录
      const selfInternal = await app.inject({
        method: 'POST',
        url: `/api/users/${internalUser.id}/reset-password`,
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { password: 'InternalNew1' },
      });
      expect(selfInternal.statusCode).toBe(200);
      const internalLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'internal@corp.test', password: 'InternalNew1' },
      });
      expect(internalLogin.statusCode).toBe(200);

      // customer（pm）改自己 → 200 + 新密码可登录
      const selfPm = await app.inject({
        method: 'POST',
        url: `/api/users/${pmUser.id}/reset-password`,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { password: 'PmNewPass1' },
      });
      expect(selfPm.statusCode).toBe(200);
      const pmLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'pm@a.test', password: 'PmNewPass1' },
      });
      expect(pmLogin.statusCode).toBe(200);
    });

    it('internal/customer 改别人 → 403；超管改自己 → 200（不禁止重置自己）', async () => {
      const list = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      const users = list.json().users as { id: string; email: string }[];
      const adminUser = users.find((u) => u.email === 'admin@corp.test');
      const createdUser = users.find((u) => u.email === 'created@corp.test');
      expect(adminUser).toBeTruthy();
      expect(createdUser).toBeTruthy();

      // internal 改别人（created@corp.test）→ 403（service 层目标鉴权）
      const deniedInternal = await app.inject({
        method: 'POST',
        url: `/api/users/${createdUser.id}/reset-password`,
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { password: 'HackPass123' },
      });
      expect(deniedInternal.statusCode).toBe(403);

      // customer 改别人 → 403
      const deniedCustomer = await app.inject({
        method: 'POST',
        url: `/api/users/${createdUser.id}/reset-password`,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { password: 'HackPass123' },
      });
      expect(deniedCustomer.statusCode).toBe(403);

      // 超管改自己 → 200
      const selfAdmin = await app.inject({
        method: 'POST',
        url: `/api/users/${adminUser.id}/reset-password`,
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { password: 'AdminNewPass1' },
      });
      expect(selfAdmin.statusCode).toBe(200);
    });

    it('用户不存在 404；非法 uuid 400；密码过短 400', async () => {
      const missing = await app.inject({
        method: 'POST',
        url: '/api/users/00000000-0000-0000-0000-000000000000/reset-password',
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { password: 'NewPass123' },
      });
      expect(missing.statusCode).toBe(404);

      const badId = await app.inject({
        method: 'POST',
        url: '/api/users/not-a-uuid/reset-password',
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { password: 'NewPass123' },
      });
      expect(badId.statusCode).toBe(400);

      // 密码过短（< 6 位）→ 400（契约校验，不落库）
      const short = await app.inject({
        method: 'POST',
        url: '/api/users/00000000-0000-4000-8000-000000000000/reset-password',
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { password: '123' },
      });
      expect(short.statusCode).toBe(400);
    });

    it('重置密码落审计 user.reset_password（metadata 含目标邮箱）', async () => {
      const owner = connectOwner();
      try {
        const rows = await owner`
          select action, actor_user_id, actor_role, resource_type, resource_id, metadata
          from audit_logs where action = 'user.reset_password' order by created_at desc`;
        // metadata 经 drizzle 双重序列化（jsonb 值本身是字符串），postgres-js 解析后代码侧再 parse 一次（同 #38 审计断言模式）
        const withMeta = rows.map((r) => ({
          ...r,
          meta: JSON.parse(r.metadata as string) as Record<string, unknown>,
        }));
        // 超管重置 created@corp.test 的那条：actor=超管 + resource_id=目标
        const target = withMeta.find((r) => r.meta.email === 'created@corp.test');
        expect(target).toBeTruthy();
        expect(target!.actor_role).toBe('super_admin');
        expect(target!.resource_type).toBe('user');
        expect(target!.resource_id).toBeTruthy();

        // 改自己同样落审计（internal 那条）
        const selfRow = withMeta.find((r) => r.meta.email === 'internal@corp.test');
        expect(selfRow).toBeTruthy();
        expect(selfRow!.actor_role).toBe('internal');
        expect(selfRow!.resource_id).toBeTruthy();
      } finally {
        await owner.end();
      }
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
        expect(deactivate!.actor_role).toBe('customer_pm');
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
