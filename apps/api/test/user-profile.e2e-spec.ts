import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CustomerCreateResponseSchema,
  ResendInviteResponseSchema,
  UpdateUserResponseSchema,
  UsersListResponseSchema,
  type UserAdmin,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * 用户资料管理 e2e（grilling 三点）：
 * - 客户邀请初始昵称 = 完整邮箱（不再是邮箱前缀）
 * - 昵称编辑（PATCH /users/:id + displayName）：本人或超管；description/role 字段级守卫
 * - 未激活客户邀请链接再发放（POST /users/:id/resend-invite）：
 *   重新生成 token（旧链接失效、有效期刷新 7 天）、权限矩阵、非客户邀请账号 409
 */
describe('User profile e2e：昵称编辑 + 客户邀请链接重发', () => {
  let app: NestFastifyApplication;

  const password = 'password123';
  let superAdminToken: string;
  let internalToken: string;
  let customerToken: string;
  /** 创建客户产生的待激活联系人账号（displayName = 完整邮箱） */
  let invitedUserId: string;
  let invitedEmail: string;
  let invitedOldToken: string;

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

  function extractToken(inviteUrl: string): string {
    return new URL(inviteUrl).searchParams.get('token')!;
  }

  async function listUsers(token: string): Promise<UserAdmin[]> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return UsersListResponseSchema.parse(res.json()).users;
  }

  async function patchUser(
    token: string,
    userId: string,
    payload: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${userId}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    return { status: res.statusCode, body: res.json() };
  }

  async function resendInvite(
    token: string,
    userId: string,
  ): Promise<{ status: number; body: unknown }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/users/${userId}/resend-invite`,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: res.json() };
  }

  async function inviteInfo(token: string): Promise<{ status: number }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/invite-info?token=${encodeURIComponent(token)}`,
    });
    return { status: res.statusCode };
  }

  beforeAll(async () => {
    await resetTestDb();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();

    const admin = await register('admin@corp.test');
    internalToken = (await register('internal@corp.test')).token;
    const owner = connectOwner();
    try {
      await owner`update users set role = 'super_admin' where id = ${admin.id}`;
    } finally {
      await owner.end();
    }
    const relogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@corp.test', password },
    });
    superAdminToken = (relogin.json() as { accessToken: string }).accessToken;

    // 客户 A：创建客户 → 待激活联系人账号（displayName 断言 + 重发对象）
    invitedEmail = 'contact-a@tenant-a.test';
    const created = await app.inject({
      method: 'POST',
      url: '/api/customers',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name: '客户A', email: invitedEmail },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = CustomerCreateResponseSchema.parse(created.json());
    invitedOldToken = extractToken(createdBody.inviteUrl);

    // 客户 B：激活一个 customer 账号供昵称编辑/权限矩阵用
    const createdB = await app.inject({
      method: 'POST',
      url: '/api/customers',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name: '客户B', email: 'contact-b@tenant-b.test' },
    });
    expect(createdB.statusCode).toBe(201);
    const tokenB = extractToken(
      (CustomerCreateResponseSchema.parse(createdB.json())).inviteUrl,
    );
    const setPw = await app.inject({
      method: 'POST',
      url: '/api/auth/set-password',
      payload: { token: tokenB, password, email: 'contact-b@tenant-b.test' },
    });
    expect(setPw.statusCode).toBe(200);
    const loginB = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'contact-b@tenant-b.test', password },
    });
    customerToken = (loginB.json() as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('客户邀请初始昵称 = 完整邮箱（grilling 点 4）', () => {
    it('创建客户 → 待激活账号 displayName = 完整邮箱；列表含 inviteKind=customer', async () => {
      const users = await listUsers(superAdminToken);
      const invited = users.find((u) => u.email === invitedEmail);
      expect(invited).toBeTruthy();
      expect(invited!.displayName).toBe(invitedEmail);
      expect(invited!.inviteKind).toBe('customer');
      invitedUserId = invited!.id;
      // 内部账号 inviteKind 为 null
      const internal = users.find((u) => u.email === 'internal@corp.test');
      expect(internal!.inviteKind).toBeNull();
    });
  });

  describe('昵称编辑（grilling 点 3）', () => {
    it('本人（customer）改自己昵称 → 200 + 持久化（重新登录可见）', async () => {
      const users = await listUsers(superAdminToken);
      const self = users.find((u) => u.email === 'contact-b@tenant-b.test')!;
      const res = await patchUser(customerToken, self.id, {
        displayName: '联系人小B',
      });
      expect(res.status).toBe(200);
      const parsed = UpdateUserResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.user.displayName).toBe('联系人小B');

      const me = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expect((me.json() as { user: { displayName: string } }).user.displayName).toBe('联系人小B');
    });

    it('本人（internal）改自己昵称 → 200', async () => {
      const users = await listUsers(superAdminToken);
      const self = users.find((u) => u.email === 'internal@corp.test')!;
      const res = await patchUser(internalToken, self.id, { displayName: '内部小C' });
      expect(res.status).toBe(200);
      expect((res.body as { user: { displayName: string } }).user.displayName).toBe('内部小C');
    });

    it('改别人（customer 改超管 / internal 改超管）→ 403', async () => {
      const users = await listUsers(superAdminToken);
      const admin = users.find((u) => u.email === 'admin@corp.test')!;
      const byCustomer = await patchUser(customerToken, admin.id, { displayName: '乱改' });
      expect(byCustomer.status).toBe(403);
      const byInternal = await patchUser(internalToken, admin.id, { displayName: '乱改' });
      expect(byInternal.status).toBe(403);
    });

    it('超管改别人（含 customer 账号）昵称 → 200', async () => {
      const users = await listUsers(superAdminToken);
      const customer = users.find((u) => u.email === 'contact-b@tenant-b.test')!;
      const res = await patchUser(superAdminToken, customer.id, { displayName: '超管改的名' });
      expect(res.status).toBe(200);
      expect((res.body as { user: { displayName: string } }).user.displayName).toBe('超管改的名');
    });

    it('昵称冲突（与已有昵称相同）→ 409；空白昵称 → 400', async () => {
      const users = await listUsers(superAdminToken);
      const target = users.find((u) => u.email === 'internal@corp.test')!;
      const dup = await patchUser(superAdminToken, target.id, { displayName: '超管改的名' });
      expect(dup.status).toBe(409);
      const blank = await patchUser(superAdminToken, target.id, { displayName: '   ' });
      expect(blank.status).toBe(400);
    });

    it('字段级守卫：本人改自己 description → 403（描述仅超管可改）', async () => {
      const users = await listUsers(superAdminToken);
      const self = users.find((u) => u.email === 'contact-b@tenant-b.test')!;
      const res = await patchUser(customerToken, self.id, { description: '想自己写描述' });
      expect(res.status).toBe(403);
    });

    it('字段级守卫：internal 改别人 role → 403（入口开放后角色仍仅超管）', async () => {
      const users = await listUsers(superAdminToken);
      const target = users.find((u) => u.email === 'admin@corp.test')!;
      const res = await patchUser(internalToken, target.id, { role: 'internal' });
      expect(res.status).toBe(403);
    });
  });

  describe('未激活客户邀请链接重发（grilling 点 2）', () => {
    it('超管重发 → 200：新链接（新 token）+ expiresAt 约 7 天后', async () => {
      const res = await resendInvite(superAdminToken, invitedUserId);
      expect(res.status).toBe(200);
      const parsed = ResendInviteResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      const { inviteUrl, expiresAt } = parsed.data!;
      expect(inviteUrl).toContain('/invite?token=');

      // 新 token ≠ 旧 token；过期时间 ≈ 7 天（重发语义：有效期刷新）
      const newToken = extractToken(inviteUrl);
      expect(newToken).not.toBe(invitedOldToken);
      const diffDays =
        (new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      expect(diffDays).toBeGreaterThan(6.5);
      expect(diffDays).toBeLessThan(7.5);

      // 旧链接立即失效（新 token 生效）
      expect((await inviteInfo(invitedOldToken)).status).toBe(400);
      expect((await inviteInfo(newToken)).status).toBe(200);
    });

    it('重发后的新链接可激活（邮箱绑定校验仍在）', async () => {
      const users = await listUsers(superAdminToken);
      const invited = users.find((u) => u.email === invitedEmail)!;
      const res = await resendInvite(superAdminToken, invited.id);
      const newToken = extractToken(
        (ResendInviteResponseSchema.parse(res.body)).inviteUrl,
      );
      const wrongEmail = await app.inject({
        method: 'POST',
        url: '/api/auth/set-password',
        payload: { token: newToken, password, email: 'wrong@tenant-a.test' },
      });
      expect(wrongEmail.statusCode).toBe(400);
      const ok = await app.inject({
        method: 'POST',
        url: '/api/auth/set-password',
        payload: { token: newToken, password, email: invitedEmail },
      });
      expect(ok.statusCode).toBe(200);
    });

    it('已激活用户重发 → 409', async () => {
      const users = await listUsers(superAdminToken);
      const active = users.find((u) => u.email === 'contact-b@tenant-b.test')!;
      const res = await resendInvite(superAdminToken, active.id);
      expect(res.status).toBe(409);
    });

    it('项目成员邀请账号（inviteKind=null）重发 → 409（去项目成员页重发）', async () => {
      // internal 建项目 + 邀请成员 → 待激活账号 inviteKind=null
      const project = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { name: 'P-Resend', tenantId: (await listCustomerId()) },
      });
      expect(project.statusCode).toBe(201);
      const projectId = (project.json() as { project: { id: string } }).project.id;
      const invited = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/members`,
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { email: 'member-x@tenant-a.test', role: 'customer_user' },
      });
      expect(invited.statusCode).toBe(201);

      const users = await listUsers(superAdminToken);
      const member = users.find((u) => u.email === 'member-x@tenant-a.test')!;
      expect(member.inviteKind).toBeNull();
      const res = await resendInvite(superAdminToken, member.id);
      expect(res.status).toBe(409);
    });

    it('权限矩阵：internal / customer 重发 → 403', async () => {
      const byInternal = await resendInvite(internalToken, invitedUserId);
      expect(byInternal.status).toBe(403);
      const users = await listUsers(superAdminToken);
      const active = users.find((u) => u.email === 'contact-b@tenant-b.test')!;
      const byCustomer = await resendInvite(customerToken, active.id);
      expect(byCustomer.status).toBe(403);
    });

    it('不存在用户 → 404；非法 uuid → 400', async () => {
      const missing = await resendInvite(superAdminToken, '00000000-0000-0000-0000-000000000000');
      expect(missing.status).toBe(404);
      const badId = await resendInvite(superAdminToken, 'not-a-uuid');
      expect(badId.status).toBe(400);
    });
  });

  async function listCustomerId(): Promise<string> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/customers?search=${encodeURIComponent('客户A')}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    return (
      res.json() as { customers: { id: string }[] }
    ).customers[0].id;
  }
});
