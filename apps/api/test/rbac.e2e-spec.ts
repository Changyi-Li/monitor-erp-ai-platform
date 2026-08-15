import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CreateUserResponseSchema,
  CustomerCreateResponseSchema,
  InviteUserResponseSchema,
  MemberInviteResponseSchema,
  MembersListResponseSchema,
  ProjectCreateResponseSchema,
  ProjectGetResponseSchema,
  ProjectsListResponseSchema,
  ResendInviteResponseSchema,
  ResetUserPasswordResponseSchema,
  SetPasswordResponseSchema,
  UpdateUserResponseSchema,
  UpdateUserStatusResponseSchema,
  UsersListResponseSchema,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * RBAC / 用户管理 / 项目边界 e2e（issue #13 验收）：
 * - 权限矩阵 API 级覆盖：角色 × 端点（建客户=超管、建项目=内部+、
 *   成员管理=内部/该项目 PM、用户/客户列表=内部/超管 + 所有客户角色本公司账号（T4/#53））
 * - 邀请链接首次设密全流程；PM 项目内邀请/停用（不可跨项目、不可升级角色）
 * - 客户跨项目 403（同租户非成员）；跨租户 404（回归 #12 语义）；内部全访问
 * - 账号级停用/启用（T5）：超管任意 / customer_pm 本公司；停用后登录/刷新 401
 * - 审计日志：登录/设密/权限变更/状态变更/项目读写在 audit_logs
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
    // T4/#53：用户管理页对公司开放——customer_pm 200（本公司账号，见 T4 专属用例）；
    // key_user/customer_user 200 且同样可见本公司账号（#53：公司花名册对所有客户角色只读）
    it('GET /api/users：内部 200 全量（含客户账号）；customer_pm 200；key_user 200 本公司账号', async () => {
      const ok = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(ok.statusCode).toBe(200);
      expect(UsersListResponseSchema.safeParse(ok.json()).success).toBe(true);
      // 内部列表全量：平台账号与客户账号都可见（T4：customer_pm 才做租户过滤）
      const internalEmails = (ok.json() as { users: { email: string }[] }).users.map(
        (u) => u.email,
      );
      expect(internalEmails).toContain('admin@corp.test');
      expect(internalEmails).toContain('pm@a.test');

      const pmOk = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${pmToken}` },
      });
      expect(pmOk.statusCode).toBe(200);

      // #53：key_user 200 且可见本公司全部账号（含 PM 与 key user 彼此）
      const self = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${keyUserToken}` },
      });
      expect(self.statusCode).toBe(200);
      expect(UsersListResponseSchema.safeParse(self.json()).success).toBe(true);
      const keyEmails = (self.json() as { users: { email: string }[] }).users.map(
        (u) => u.email,
      );
      expect(keyEmails).toContain('pm@a.test');
      expect(keyEmails).toContain('key@a.test');
      // 平台账号与他司账号不可见
      expect(keyEmails).not.toContain('admin@corp.test');
      expect(keyEmails).not.toContain('pm-b@b.test');
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

    // #38+T3：角色防护矩阵 —— 跨域 400（internal↔customer 双向）/ internal 与客户 403 / 自己 409
    it('PATCH 角色防护：跨域 400 双向；internal/客户 403；自己 409', async () => {
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

      // 跨域：internal 目标赋客户角色 → 400（T3 同域约束，取代旧契约枚举拒绝）
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

      // 跨域：customer 目标赋内部角色 → 400（T3 同域约束：客户三档互调，↔内部禁止）
      const customerTarget = await app.inject({
        method: 'PATCH',
        url: `/api/users/${pmUser.id}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { role: 'super_admin' },
      });
      expect(customerTarget.statusCode).toBe(400);
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

    // T3：客户 PM 产生（建客户默认 PM 之外的另一来源）——超管可调客户三档：
    // 互调 200 回环、升 PM 后新登录 JWT 生效且成员管理权真实可用、跨域 400
    it('T3 角色调整：客户三档互调 200（升 PM 后新登录成员管理生效）；跨域 400', async () => {
      // 目标用户：register（默认 internal）→ owner 降为 customer_user（等价存量迁移/建客户联系人）
      const reg = await register('t3cu@corp.test');
      const owner = connectOwner();
      try {
        await owner`update users set role = 'customer_user' where id = ${reg.id}`;
      } finally {
        await owner.end();
      }

      const patch = (id: string, role: string) =>
        app.inject({
          method: 'PATCH',
          url: `/api/users/${id}`,
          headers: { authorization: `Bearer ${superAdminToken}` },
          payload: { role },
        });

      // 客户三档互调全部 200（customer_user → key_user → pm）
      const toKey = await patch(reg.id, 'customer_key_user');
      expect(toKey.statusCode).toBe(200);
      expect(UpdateUserResponseSchema.safeParse(toKey.json()).success).toBe(true);
      expect((toKey.json() as { user: { role: string } }).user.role).toBe('customer_key_user');
      const toPm = await patch(reg.id, 'customer_pm');
      expect(toPm.statusCode).toBe(200);
      expect(UpdateUserResponseSchema.safeParse(toPm.json()).success).toBe(true);
      expect((toPm.json() as { user: { role: string } }).user.role).toBe('customer_pm');

      // 非法角色（zod 枚举拒绝，契约层）→ 400
      const bogus = await patch(reg.id, 'bogus');
      expect(bogus.statusCode).toBe(400);

      // 非超管改自己角色 → 403（目标鉴权放行自己，role 字段级守卫拒绝）
      const selfDenied = await app.inject({
        method: 'PATCH',
        url: `/api/users/${internalUserId}`,
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { role: 'super_admin' },
      });
      expect(selfDenied.statusCode).toBe(403);

      // 先建立租户/成员关系，再登录：JWT 携带 customer_pm 声明 + 租户上下文
      const owner2 = connectOwner();
      try {
        await owner2`insert into user_tenants (user_id, customer_id) values (${reg.id}, ${cidA})`;
        await owner2`insert into project_members (project_id, user_id) values (${projectAId}, ${reg.id})`;
      } finally {
        await owner2.end();
      }
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 't3cu@corp.test', password },
      });
      expect(login.statusCode).toBe(200);
      const t3Token = (login.json() as { accessToken: string }).accessToken;
      const me = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${t3Token}` },
      });
      expect((me.json() as { user: { role: string } }).user.role).toBe('customer_pm');

      // 成员管理权真实生效（customer_pm + active 成员 → 成员列表 200）
      const members = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/members`,
        headers: { authorization: `Bearer ${t3Token}` },
      });
      expect(members.statusCode).toBe(200);
      expect(MembersListResponseSchema.safeParse(members.json()).success).toBe(true);

      // 客户 → 内部跨域 → 400；调回 customer_user 收尾
      const cross = await patch(reg.id, 'internal');
      expect(cross.statusCode).toBe(400);
      const back = await patch(reg.id, 'customer_user');
      expect(back.statusCode).toBe(200);
      expect(UpdateUserResponseSchema.safeParse(back.json()).success).toBe(true);

      // 清理：移除测试成员关系（防污染后续用例；用户行保留无妨）
      const owner3 = connectOwner();
      try {
        await owner3`delete from project_members where user_id = ${reg.id}`;
        await owner3`delete from user_tenants where user_id = ${reg.id}`;
      } finally {
        await owner3.end();
      }
    });

    // T4/#53：用户管理页对公司开放——所有客户角色可见本公司账号（租户过滤）；
    // 平台账号与跨租户账号不可见
    it('T4 用户列表：customer_pm 200 仅本公司账号；key_user/customer_user 200 本公司账号', async () => {
      const pmList = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${pmToken}` },
      });
      expect(pmList.statusCode).toBe(200);
      expect(UsersListResponseSchema.safeParse(pmList.json()).success).toBe(true);
      const pmEmails = (pmList.json() as { users: { email: string }[] }).users.map(
        (u) => u.email,
      );
      // 本公司（cidA）账号可见：PM 本人 + key user
      expect(pmEmails).toContain('pm@a.test');
      expect(pmEmails).toContain('key@a.test');
      // 平台账号与跨租户账号（客户 B 的 PM）不可见
      expect(pmEmails).not.toContain('admin@corp.test');
      expect(pmEmails).not.toContain('internal@corp.test');
      expect(pmEmails).not.toContain('created@corp.test');
      expect(pmEmails).not.toContain('pm-b@b.test');

      // #53：customer_key_user → 200 且同样可见本公司账号（含 PM）
      const keyList = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${keyUserToken}` },
      });
      expect(keyList.statusCode).toBe(200);
      const keyEmails = (keyList.json() as { users: { email: string }[] }).users.map(
        (u) => u.email,
      );
      expect(keyEmails).toContain('pm@a.test');
      expect(keyEmails).toContain('key@a.test');
      expect(keyEmails).not.toContain('admin@corp.test');
      expect(keyEmails).not.toContain('pm-b@b.test');

      // #54：客户列表项带所属客户（cidA = 客户A）；内部/超管列表里客户账号同样带，
      // 平台账号为 null
      const pmRows = pmList.json() as {
        users: { email: string; customerId: string | null; customerName: string | null }[];
      };
      const pmRow = pmRows.users.find((u) => u.email === 'pm@a.test')!;
      expect(pmRow.customerId).toBe(cidA);
      expect(pmRow.customerName).toBe('客户A');
      const keyRow = (keyList.json() as typeof pmRows).users.find(
        (u) => u.email === 'key@a.test',
      )!;
      expect(keyRow.customerId).toBe(cidA);
      expect(keyRow.customerName).toBe('客户A');
      // 内部/超管列表：客户账号带客户名，平台账号为 null
      const internalList = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      const internalRows = internalList.json() as typeof pmRows;
      expect(
        internalRows.users.find((u) => u.email === 'admin@corp.test')!.customerName,
      ).toBeNull();
      expect(
        internalRows.users.find((u) => u.email === 'pm@a.test')!.customerName,
      ).toBe('客户A');

      // #53：customer_user → 200（T3 用例收尾已把 t3cu 调回 customer_user 且清理了
      // 租户行——重新登录取最新角色；无租户 → 空列表，但不泄露任何平台/他司账号）
      const cuLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 't3cu@corp.test', password },
      });
      expect(cuLogin.statusCode).toBe(200);
      const cuToken = (cuLogin.json() as { accessToken: string }).accessToken;
      const cuList = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${cuToken}` },
      });
      expect(cuList.statusCode).toBe(200);
      const cuEmails = (cuList.json() as { users: { email: string }[] }).users.map(
        (u) => u.email,
      );
      expect(cuEmails).not.toContain('admin@corp.test');
      expect(cuEmails).not.toContain('pm-b@b.test');
    });

    // #53：普通客户用户写操作边界——可改自己昵称/密码，但改别人/改描述仍拒绝
    it('#53 普通客户用户只读边界：改自己昵称 200；改别人 403；改描述 403；重置自己密码 200', async () => {
      const keyList = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${keyUserToken}` },
      });
      const self = (keyList.json() as { users: { id: string; email: string }[] }).users.find(
        (u) => u.email === 'key@a.test',
      )!;

      // 改自己昵称 → 200（本人可改，grilling 语义）
      const rename = await app.inject({
        method: 'PATCH',
        url: `/api/users/${self.id}`,
        headers: { authorization: `Bearer ${keyUserToken}` },
        payload: { displayName: 'T7自改昵称' },
      });
      expect(rename.statusCode).toBe(200);
      expect(rename.json().user.displayName).toBe('T7自改昵称');

      // 改别人（PM）→ 403；改自己描述 → 403（描述仅超管）
      const pmList = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${pmToken}` },
      });
      const pm = (pmList.json() as { users: { id: string; email: string }[] }).users.find(
        (u) => u.email === 'pm@a.test',
      )!;
      const patchOther = await app.inject({
        method: 'PATCH',
        url: `/api/users/${pm.id}`,
        headers: { authorization: `Bearer ${keyUserToken}` },
        payload: { displayName: '越权' },
      });
      expect(patchOther.statusCode).toBe(403);

      const patchDesc = await app.inject({
        method: 'PATCH',
        url: `/api/users/${self.id}`,
        headers: { authorization: `Bearer ${keyUserToken}` },
        payload: { description: '越权描述' },
      });
      expect(patchDesc.statusCode).toBe(403);

      // 重置自己密码 → 200（改密码后恢复原密码，避免影响后续用例）
      const reset = await app.inject({
        method: 'POST',
        url: `/api/users/${self.id}/reset-password`,
        headers: { authorization: `Bearer ${keyUserToken}` },
        payload: { password: 'T7NewPass123' },
      });
      expect(reset.statusCode).toBe(200);
      const relogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'key@a.test', password: 'T7NewPass123' },
      });
      expect(relogin.statusCode).toBe(200);
      // 恢复原密码（后续用例假设 keyUserToken 密码 = password）+ 恢复原昵称
      const restore = await app.inject({
        method: 'POST',
        url: `/api/users/${self.id}/reset-password`,
        headers: { authorization: `Bearer ${keyUserToken}` },
        payload: { password },
      });
      expect(restore.statusCode).toBe(200);
      const renameBack = await app.inject({
        method: 'PATCH',
        url: `/api/users/${self.id}`,
        headers: { authorization: `Bearer ${keyUserToken}` },
        payload: { displayName: 'key' },
      });
      expect(renameBack.statusCode).toBe(200);
    });

    // #54：多归属用户——列表单行无重复；超管视角取最早归属（created_at）；
    // 客户 PM 视角取本租户归属（PATCH/status 响应与列表一致）
    it('#54 多租户归属：列表单行；超管取最早归属；客户 PM 取本租户归属', async () => {
      const owner = connectOwner();
      try {
        const [multi] = await owner`insert into users (email, password_hash, display_name, role, is_active)
          values ('multi@a.test', 'x', 'Multi', 'customer_user', true) returning id`;
        // 先插 cidB（更早）再插 cidA（更晚）——超管视角应取最早（客户B）
        await owner`insert into user_tenants (user_id, customer_id) values (${multi.id}, ${cidB})`;
        await owner`insert into user_tenants (user_id, customer_id) values (${multi.id}, ${cidA})`;
      } finally {
        await owner.end();
      }

      // 超管列表：单行（join 不产生重复）+ 最早归属 = 客户B
      const adminList = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      const adminRows = (
        adminList.json() as { users: { email: string; customerName: string | null }[] }
      ).users.filter((u) => u.email === 'multi@a.test');
      expect(adminRows).toHaveLength(1);
      expect(adminRows[0].customerName).toBe('客户B');

      // 客户 PM（cidA）列表：本租户归属 = 客户A（即使它是更晚的归属）
      const pmList = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${pmToken}` },
      });
      const pmMulti = (
        pmList.json() as { users: { id: string; email: string; customerName: string | null }[] }
      ).users.find((u) => u.email === 'multi@a.test')!;
      expect(pmMulti.customerName).toBe('客户A');

      // PATCH status 响应与列表一致（loadCustomer 租户限定，不回落他司最早归属）
      const off = await app.inject({
        method: 'PATCH',
        url: `/api/users/${pmMulti.id}/status`,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { isActive: false },
      });
      expect(off.statusCode).toBe(200);
      expect(
        (off.json() as { user: { customerName: string | null } }).user.customerName,
      ).toBe('客户A');
      const on = await app.inject({
        method: 'PATCH',
        url: `/api/users/${pmMulti.id}/status`,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { isActive: true },
      });
      expect(on.statusCode).toBe(200);

      // 清理（user_tenants 级联删除）
      const owner2 = connectOwner();
      try {
        await owner2`delete from users where email = 'multi@a.test'`;
      } finally {
        await owner2.end();
      }
    });

    // T5：账号级停用/启用（spec-v1 US5——客户 PM 停用本公司普通用户）
    // 权限：超管任何账号（自己 409）；customer_pm 本公司账号（他司 404、自己 409）；
    // internal/key_user 403；停用后登录/刷新 401；启用恢复；幂等 200
    it('T5 超管停用内部账号：200 契约通过；登录/刷新 401；幂等 200；启用恢复登录', async () => {
      // 目标：created@corp.test（internal；本用例先于「超管重置他人密码」，密码仍是 NewPass123）
      const before = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'created@corp.test', password: 'NewPass123' },
      });
      expect(before.statusCode).toBe(200);
      const refreshToken = (before.json() as { refreshToken: string }).refreshToken;

      const list = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      const target = list
        .json()
        .users.find((u: { email: string }) => u.email === 'created@corp.test');
      expect(target).toBeTruthy();

      const status = (isActive: boolean) =>
        app.inject({
          method: 'PATCH',
          url: `/api/users/${target.id}/status`,
          headers: { authorization: `Bearer ${superAdminToken}` },
          payload: { isActive },
        });

      const off = await status(false);
      expect(off.statusCode).toBe(200);
      expect(UpdateUserStatusResponseSchema.safeParse(off.json()).success).toBe(true);
      expect((off.json() as { user: { isActive: boolean } }).user.isActive).toBe(false);
      // 已激活账号无邀请 token：invitePending 恒 false（「已停用」而非「未激活」）
      expect(
        (off.json() as { user: { invitePending: boolean } }).user.invitePending,
      ).toBe(false);

      // 停用后：登录 401（统一文案）+ 轮换式刷新 401（会话立即不可续）
      const loginDenied = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'created@corp.test', password: 'NewPass123' },
      });
      expect(loginDenied.statusCode).toBe(401);
      const refreshDenied = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: { refreshToken },
      });
      expect(refreshDenied.statusCode).toBe(401);

      // 幂等：重复停用 200（已授权，直接返回）
      const again = await status(false);
      expect(again.statusCode).toBe(200);

      // 启用恢复登录
      const on = await status(true);
      expect(on.statusCode).toBe(200);
      expect((on.json() as { user: { isActive: boolean } }).user.isActive).toBe(true);
      const loginBack = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'created@corp.test', password: 'NewPass123' },
      });
      expect(loginBack.statusCode).toBe(200);
    });

    it('T5 客户 PM 停用本公司 key user：200 + 登录 401；他司账号 404；自己/超管 409；key_user/internal 403', async () => {
      // 本公司（cidA）key user
      const pmList = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${pmToken}` },
      });
      const key = pmList
        .json()
        .users.find((u: { email: string }) => u.email === 'key@a.test');
      expect(key).toBeTruthy();

      const off = await app.inject({
        method: 'PATCH',
        url: `/api/users/${key.id}/status`,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { isActive: false },
      });
      expect(off.statusCode).toBe(200);
      const keyLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'key@a.test', password },
      });
      expect(keyLogin.statusCode).toBe(401);

      // 启用恢复（后续用例依赖 keyUserToken 登录态）
      const on = await app.inject({
        method: 'PATCH',
        url: `/api/users/${key.id}/status`,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { isActive: true },
      });
      expect(on.statusCode).toBe(200);
      const keyBack = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'key@a.test', password },
      });
      expect(keyBack.statusCode).toBe(200);

      // 他司账号（客户 B 的 PM，不在本公司 user_tenants）→ 404（不可见语义）
      const adminList = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      const other = adminList
        .json()
        .users.find((u: { email: string }) => u.email === 'pm-b@b.test');
      expect(other).toBeTruthy();
      const cross = await app.inject({
        method: 'PATCH',
        url: `/api/users/${other.id}/status`,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { isActive: false },
      });
      expect(cross.statusCode).toBe(404);

      // 自己 → 409（防锁死）；超管停自己同样 409
      const pmMe = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${pmToken}` },
      });
      const pmId = (pmMe.json() as { user: { id: string } }).user.id;
      const self409 = await app.inject({
        method: 'PATCH',
        url: `/api/users/${pmId}/status`,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { isActive: false },
      });
      expect(self409.statusCode).toBe(409);
      const adminMe = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      const adminId = (adminMe.json() as { user: { id: string } }).user.id;
      const adminSelf = await app.inject({
        method: 'PATCH',
        url: `/api/users/${adminId}/status`,
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { isActive: false },
      });
      expect(adminSelf.statusCode).toBe(409);

      // key_user / internal → 403（方法级 @Roles 仅超管 + customer_pm）
      const keyDenied = await app.inject({
        method: 'PATCH',
        url: `/api/users/${key.id}/status`,
        headers: { authorization: `Bearer ${keyUserToken}` },
        payload: { isActive: false },
      });
      expect(keyDenied.statusCode).toBe(403);
      const internalDenied = await app.inject({
        method: 'PATCH',
        url: `/api/users/${key.id}/status`,
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { isActive: false },
      });
      expect(internalDenied.statusCode).toBe(403);

      // 非法 body（契约校验）→ 400
      const badBody = await app.inject({
        method: 'PATCH',
        url: `/api/users/${key.id}/status`,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { isActive: 'yes' },
      });
      expect(badBody.statusCode).toBe(400);
    });

    it('T5 边界：客户 PM 不能停本公司其他 PM（403）；超管可停；fellow PM 停用恢复', async () => {
      // fellow PM：t3cu（T3 用例收尾已调回 customer_user）→ 升 PM + 插入本公司租户
      const owner = connectOwner();
      try {
        await owner`update users set role = 'customer_pm' where email = 't3cu@corp.test'`;
        await owner`
          insert into user_tenants (user_id, customer_id)
          select id, ${cidA} from users where email = 't3cu@corp.test'`;
      } finally {
        await owner.end();
      }
      try {
        const list = await app.inject({
          method: 'GET',
          url: '/api/users',
          headers: { authorization: `Bearer ${superAdminToken}` },
        });
        const fellow = list
          .json()
          .users.find((u: { email: string }) => u.email === 't3cu@corp.test');
        expect(fellow).toBeTruthy();

        // 客户 PM 停本公司其他 PM → 403（quiz 固化：PM 只管理 Key User/普通用户）
        const denied = await app.inject({
          method: 'PATCH',
          url: `/api/users/${fellow.id}/status`,
          headers: { authorization: `Bearer ${pmToken}` },
          payload: { isActive: false },
        });
        expect(denied.statusCode).toBe(403);

        // 超管不受限：停用 → 200，再启用恢复（fellow 后续无依赖，仍恢复卫生）
        const off = await app.inject({
          method: 'PATCH',
          url: `/api/users/${fellow.id}/status`,
          headers: { authorization: `Bearer ${superAdminToken}` },
          payload: { isActive: false },
        });
        expect(off.statusCode).toBe(200);
        const on = await app.inject({
          method: 'PATCH',
          url: `/api/users/${fellow.id}/status`,
          headers: { authorization: `Bearer ${superAdminToken}` },
          payload: { isActive: true },
        });
        expect(on.statusCode).toBe(200);
      } finally {
        // 清理：移除租户行 + 调回 customer_user（T3 收尾状态）
        const owner2 = connectOwner();
        try {
          await owner2`
            delete from user_tenants
            where user_id = (select id from users where email = 't3cu@corp.test')`;
          await owner2`update users set role = 'customer_user' where email = 't3cu@corp.test'`;
        } finally {
          await owner2.end();
        }
      }
    });

    it('T5 待激活账号：启用 → 400（防死锁邀请流程）；邀请链接仍可用', async () => {
      const invite = await inviteMember(internalToken, projectAId, {
        email: 't5pending@a.test',
        role: 'customer_user',
      });
      expect(invite.status).toBe(201);
      const token = new URL(invite.inviteUrl!).searchParams.get('token')!;

      const list = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      const pending = list
        .json()
        .users.find((u: { email: string }) => u.email === 't5pending@a.test');
      expect(pending).toBeTruthy();
      expect(pending.isActive).toBe(false);
      // 项目成员邀请账号（inviteKind=null）同样持有 token → invitePending=true
      // （UI 据此显示「未激活」而非「已停用」）
      expect(pending.invitePending).toBe(true);

      // 超管 / 客户 PM（本公司账号）启用 → 400（没有「启用」一说，应走邀请链接）
      const enable = await app.inject({
        method: 'PATCH',
        url: `/api/users/${pending.id}/status`,
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { isActive: true },
      });
      expect(enable.statusCode).toBe(400);
      const pmEnable = await app.inject({
        method: 'PATCH',
        url: `/api/users/${pending.id}/status`,
        headers: { authorization: `Bearer ${pmToken}` },
        payload: { isActive: true },
      });
      expect(pmEnable.statusCode).toBe(400);

      // 邀请链接未被破坏（未死锁：设密仍可激活）
      const activate = await app.inject({
        method: 'POST',
        url: '/api/auth/set-password',
        payload: { token, password },
      });
      expect(activate.statusCode).toBe(200);

      // 清理：移除测试账号的租户/成员行（用户行保留无妨）
      const owner = connectOwner();
      try {
        await owner`
          delete from project_members
          where user_id = (select id from users where email = 't5pending@a.test')`;
        await owner`
          delete from user_tenants
          where user_id = (select id from users where email = 't5pending@a.test')`;
      } finally {
        await owner.end();
      }
    });

    it('T5 停用/启用落审计 user.status_change（actor + metadata 含目标邮箱与目标状态）', async () => {
      const owner = connectOwner();
      try {
        const rows = await owner`
          select action, actor_user_id, actor_role, resource_type, resource_id, metadata
          from audit_logs where action = 'user.status_change' order by created_at asc`;
        const withMeta = rows.map((r) => ({
          ...r,
          meta: JSON.parse(r.metadata as string) as Record<string, unknown>,
        }));
        // 超管停用 created@corp.test（第一条：actor=超管，目标邮箱 + isActive:false）
        const adminOff = withMeta.find(
          (r) => r.meta.email === 'created@corp.test' && r.meta.isActive === false,
        );
        expect(adminOff).toBeTruthy();
        expect(adminOff!.actor_role).toBe('super_admin');
        expect(adminOff!.resource_type).toBe('user');
        expect(adminOff!.resource_id).toBeTruthy();
        // 客户 PM 停用本公司 key user（actor=customer_pm）
        const pmOff = withMeta.find(
          (r) => r.meta.email === 'key@a.test' && r.meta.isActive === false,
        );
        expect(pmOff).toBeTruthy();
        expect(pmOff!.actor_role).toBe('customer_pm');
      } finally {
        await owner.end();
      }
    });

    // T6：客户 PM 邀请本公司用户（spec-v1 US5 邀请半场——补齐 T4「邀请」缺口）
    // 权限：仅 customer_pm（超管/内部/key_user/customer_user 403）；新账号 = 待激活 +
    // user_tenants 归属本公司 + 邮箱绑定邀请链接（inviteKind=customer，错误邮箱设密 400）；
    // 档位限 key_user/customer_user（customer_pm 档契约 400）；邮箱/昵称重复 409；
    // 重发：本公司待激活 200 / 他司 404 / 本公司 fellow PM 403 / 已激活 409
    describe('T6 客户 PM 邀请本公司用户', () => {
      it('PM 邀请本公司普通用户：201 契约通过；待激活入本公司列表；链接绑定邮箱可激活', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/users/invite',
          headers: { authorization: `Bearer ${pmToken}` },
          payload: { email: 't6user@a.test', role: 'customer_user' },
        });
        expect(res.statusCode).toBe(201);
        const parsed = InviteUserResponseSchema.safeParse(res.json());
        expect(parsed.success).toBe(true);
        const { inviteUrl, expiresAt, user } = parsed.data!;
        expect(inviteUrl).toContain('/invite?token=');
        expect(user.role).toBe('customer_user');
        expect(user.isActive).toBe(false);
        expect(user.inviteKind).toBe('customer');
        // 待激活判据：持有未消耗邀请 token
        expect(user.invitePending).toBe(true);
        // 有效期 7 天（±半日容差）
        const expiresIn = Date.parse(expiresAt) - Date.now();
        expect(expiresIn).toBeGreaterThan(6.5 * 24 * 3600 * 1000);
        expect(expiresIn).toBeLessThan(7.5 * 24 * 3600 * 1000);

        // 新账号出现在 PM 的本公司列表（T4 租户过滤）
        const list = await app.inject({
          method: 'GET',
          url: '/api/users',
          headers: { authorization: `Bearer ${pmToken}` },
        });
        const inList = list
          .json()
          .users.find((u: { email: string }) => u.email === 't6user@a.test');
        expect(inList).toBeTruthy();
        expect(inList.role).toBe('customer_user');
        expect(inList.isActive).toBe(false);

        // 链接绑定邮箱：错误邮箱设密 400（防链接转发）；正确邮箱 200 → 登录 200
        const token = new URL(inviteUrl).searchParams.get('token')!;
        const wrongEmail = await app.inject({
          method: 'POST',
          url: '/api/auth/set-password',
          payload: { token, password, email: 'other@a.test' },
        });
        expect(wrongEmail.statusCode).toBe(400);
        const activate = await app.inject({
          method: 'POST',
          url: '/api/auth/set-password',
          payload: { token, password, email: 't6user@a.test' },
        });
        expect(activate.statusCode).toBe(200);
        const login = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: 't6user@a.test', password },
        });
        expect(login.statusCode).toBe(200);
      });

      it('PM 邀请 Key User 档：201 role=customer_key_user；customer_pm 档 → 400（契约拒绝）', async () => {
        const keyRes = await app.inject({
          method: 'POST',
          url: '/api/users/invite',
          headers: { authorization: `Bearer ${pmToken}` },
          payload: { email: 't6key@a.test', role: 'customer_key_user', displayName: 'T6Key' },
        });
        expect(keyRes.statusCode).toBe(201);
        const parsed = InviteUserResponseSchema.safeParse(keyRes.json());
        expect(parsed.success).toBe(true);
        expect(parsed.data!.user.role).toBe('customer_key_user');
        expect(parsed.data!.user.displayName).toBe('T6Key');

        const pmRole = await app.inject({
          method: 'POST',
          url: '/api/users/invite',
          headers: { authorization: `Bearer ${pmToken}` },
          payload: { email: 't6pm@a.test', role: 'customer_pm' },
        });
        expect(pmRole.statusCode).toBe(400);

        const badRole = await app.inject({
          method: 'POST',
          url: '/api/users/invite',
          headers: { authorization: `Bearer ${pmToken}` },
          payload: { email: 't6bad@a.test', role: 'internal' },
        });
        expect(badRole.statusCode).toBe(400);
      });

      it('已注册邮箱 / 昵称重复 → 409（公司级邀请只建新账号）', async () => {
        const dupEmail = await app.inject({
          method: 'POST',
          url: '/api/users/invite',
          headers: { authorization: `Bearer ${pmToken}` },
          payload: { email: 'key@a.test' }, // 已激活 key user
        });
        expect(dupEmail.statusCode).toBe(409);

        const dupName = await app.inject({
          method: 'POST',
          url: '/api/users/invite',
          headers: { authorization: `Bearer ${pmToken}` },
          payload: { email: 't6dup@a.test', displayName: 'internal' }, // register 默认昵称
        });
        expect(dupName.statusCode).toBe(409);
      });

      it('权限：超管/internal/key_user/customer_user/未登录 → 403/401（仅 customer_pm）', async () => {
        for (const [label, token] of [
          ['sa', superAdminToken],
          ['internal', internalToken],
          ['key', keyUserToken],
        ] as const) {
          const res = await app.inject({
            method: 'POST',
            url: '/api/users/invite',
            headers: { authorization: `Bearer ${token}` },
            payload: { email: `t6-${label}@a.test` },
          });
          expect(res.statusCode).toBe(403);
        }
        // customer_user 档（t3cu 收尾已调回 customer_user）
        const cuLogin = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: 't3cu@corp.test', password },
        });
        expect(cuLogin.statusCode).toBe(200);
        const cuToken = (cuLogin.json() as { accessToken: string }).accessToken;
        const cuRes = await app.inject({
          method: 'POST',
          url: '/api/users/invite',
          headers: { authorization: `Bearer ${cuToken}` },
          payload: { email: 't6cu@a.test' },
        });
        expect(cuRes.statusCode).toBe(403);

        const anon = await app.inject({
          method: 'POST',
          url: '/api/users/invite',
          payload: { email: 't6anon@a.test' },
        });
        expect(anon.statusCode).toBe(401);
      });

      it('重发邀请：本公司待激活 200 新链接；已激活 409；他司待激活 404；本公司 fellow PM 403', async () => {
        // 本公司待激活（先邀请不激活）
        const invite = await app.inject({
          method: 'POST',
          url: '/api/users/invite',
          headers: { authorization: `Bearer ${pmToken}` },
          payload: { email: 't6resend@a.test', role: 'customer_user' },
        });
        expect(invite.statusCode).toBe(201);
        const pendingId = (invite.json() as { user: { id: string } }).user.id;

        // ① 本公司待激活 → 200 新链接（旧链接失效：新 token ≠ 旧 token）
        const oldToken = new URL(
          (invite.json() as { inviteUrl: string }).inviteUrl,
        ).searchParams.get('token')!;
        const resend = await app.inject({
          method: 'POST',
          url: `/api/users/${pendingId}/resend-invite`,
          headers: { authorization: `Bearer ${pmToken}` },
        });
        expect(resend.statusCode).toBe(200);
        const resendBody = ResendInviteResponseSchema.safeParse(resend.json());
        expect(resendBody.success).toBe(true);
        const newToken = new URL(resendBody.data!.inviteUrl).searchParams.get('token')!;
        expect(newToken).not.toBe(oldToken);

        // ② 已激活 → 409（t6user@a.test 已激活）
        const activated = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: 't6user@a.test', password },
        });
        expect(activated.statusCode).toBe(200);
        const list = await app.inject({
          method: 'GET',
          url: '/api/users',
          headers: { authorization: `Bearer ${pmToken}` },
        });
        const activatedUser = list
          .json()
          .users.find((u: { email: string }) => u.email === 't6user@a.test');
        const resendActive = await app.inject({
          method: 'POST',
          url: `/api/users/${activatedUser.id}/resend-invite`,
          headers: { authorization: `Bearer ${pmToken}` },
        });
        expect(resendActive.statusCode).toBe(409);

        // ③ 他司待激活（客户C 创建时的待激活 PM 联系人）→ 404 不可见语义
        const cList = await app.inject({
          method: 'GET',
          url: '/api/users',
          headers: { authorization: `Bearer ${superAdminToken}` },
        });
        const contactC = cList
          .json()
          .users.find((u: { email: string }) => u.email === 'contact-c@rbac.test');
        expect(contactC).toBeTruthy();
        const resendOther = await app.inject({
          method: 'POST',
          url: `/api/users/${contactC.id}/resend-invite`,
          headers: { authorization: `Bearer ${pmToken}` },
        });
        expect(resendOther.statusCode).toBe(404);

        // ③' 他司已激活账号（客户 B 的 PM）→ 404（租户校验先行，防探测——
        // 即使目标已激活也不泄露存在性与状态）
        const resendOtherActive = await app.inject({
          method: 'POST',
          url: `/api/users/00000000-0000-4000-8000-000000000000/resend-invite`,
          headers: { authorization: `Bearer ${pmToken}` },
        });
        expect(resendOtherActive.statusCode).toBe(404);
        const bList = await app.inject({
          method: 'GET',
          url: '/api/users',
          headers: { authorization: `Bearer ${superAdminToken}` },
        });
        const pmB = bList
          .json()
          .users.find((u: { email: string }) => u.email === 'pm-b@b.test');
        expect(pmB).toBeTruthy();
        const resendPmB = await app.inject({
          method: 'POST',
          url: `/api/users/${pmB.id}/resend-invite`,
          headers: { authorization: `Bearer ${pmToken}` },
        });
        expect(resendPmB.statusCode).toBe(404);

        // ④ 本公司 fellow PM 待激活 → 403（与 T5 停用语义一致：PM 不管理 PM）
        const owner = connectOwner();
        try {
          const [fellow] = await owner`insert into users
            (email, password_hash, display_name, role, is_active, invite_token_hash, invite_expires_at, invite_kind)
            values ('t6fellow@a.test', 'x', 'T6Fellow', 'customer_pm', false,
                    't6-fellow-hash', now() + interval '7 days', 'customer') returning id`;
          await owner`insert into user_tenants (user_id, customer_id) values (${fellow.id}, ${cidA})`;
          const resendFellow = await app.inject({
            method: 'POST',
            url: `/api/users/${fellow.id}/resend-invite`,
            headers: { authorization: `Bearer ${pmToken}` },
          });
          expect(resendFellow.statusCode).toBe(403);
          // 超管可重发任何客户账号（fellow PM 也放行）
          const resendByAdmin = await app.inject({
            method: 'POST',
            url: `/api/users/${fellow.id}/resend-invite`,
            headers: { authorization: `Bearer ${superAdminToken}` },
          });
          expect(resendByAdmin.statusCode).toBe(200);
        } finally {
          await owner.end();
        }
      });

      it('邀请落审计 user.invite（companyInvite 标记，actor=customer_pm）', async () => {
        const owner = connectOwner();
        try {
          const rows = await owner`
            select action, actor_user_id, actor_role, resource_type, resource_id, metadata
            from audit_logs where action = 'user.invite' and metadata::text like '%companyInvite%'
            order by created_at desc limit 3`;
          expect(rows.length).toBeGreaterThan(0);
          const first = rows[0];
          expect(first.actor_role).toBe('customer_pm');
          expect(first.resource_type).toBe('user');
          expect(first.resource_id).toBeTruthy();
          const meta = JSON.parse(first.metadata as string) as Record<string, unknown>;
          expect(meta.companyInvite).toBe(true);
        } finally {
          await owner.end();
        }
      });
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
