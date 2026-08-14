import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CustomerCreateResponseSchema,
  CustomersListResponseSchema,
  InviteInfoResponseSchema,
  MemberInviteResponseSchema,
  MembersListResponseSchema,
  ProjectCreateResponseSchema,
  SetPasswordResponseSchema,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * 客户邀请 e2e（issue #50 验收）：
 * - ① 超管创建客户（name + 联系人邮箱）→ 201 + inviteUrl（自动建待激活 customer 账号）
 * - ② 邮箱冲突 → 409，不产生半成品客户；缺失/非法邮箱 → 400；非超管 → 403
 * - ③ invite-info：客户邀请 → {kind:'customer'}；项目邀请 → {kind:'project'}；无效 → 400
 * - ④ set-password 客户邀请：邮箱与绑定不一致 → 400；一致 → 激活成功、token 失效
 * - ⑤ 激活后登录：customer 角色 + RLS 只见所属客户
 * - ⑥ 衔接：内部在项目详情页可直接把激活账号加为成员（inviteUrl=null 直接加入）
 */
describe('Customer invite e2e：创建客户自动生成邮箱绑定邀请链接', () => {
  let app: NestFastifyApplication;

  const password = 'password123';
  let superAdminToken: string;
  let internalToken: string;

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

  async function createCustomer(
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/customers',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    return { status: res.statusCode, body: res.json() };
  }

  function extractToken(inviteUrl: string): string {
    return new URL(inviteUrl).searchParams.get('token')!;
  }

  async function setPassword(token: string, body: Record<string, unknown>): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/set-password',
      payload: { token, password, ...body },
    });
    return res.statusCode;
  }

  async function inviteInfo(token: string): Promise<{ status: number; body: unknown }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/invite-info?token=${encodeURIComponent(token)}`,
    });
    return { status: res.statusCode, body: res.json() };
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
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('验收 ①：创建客户 → 客户 + 邀请链接', () => {
    it('超管创建客户（name + email）→ 201，响应含 customer 与 inviteUrl', async () => {
      const res = await createCustomer(superAdminToken, {
        name: '客户C',
        email: 'contact-c@tenant-c.test',
        industry: '物流',
      });
      expect(res.status).toBe(201);
      const parsed = CustomerCreateResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.customer.name).toBe('客户C');
      expect(parsed.data!.inviteUrl).toContain('/invite?token=');
    });

    it('缺失 email → 400；非法 email → 400', async () => {
      const noEmail = await createCustomer(superAdminToken, { name: '客户X' });
      expect(noEmail.status).toBe(400);
      const badEmail = await createCustomer(superAdminToken, { name: '客户X', email: 'nope' });
      expect(badEmail.status).toBe(400);
    });
  });

  describe('验收 ②：邮箱冲突与权限', () => {
    it('邮箱已被占用 → 409，且不产生客户', async () => {
      const before = await app.inject({
        method: 'GET',
        url: '/api/customers',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      const beforeCount = (CustomersListResponseSchema.parse(before.json())).customers.length;

      // contact-c@tenant-c.test 已在验收 ① 被占
      const res = await createCustomer(superAdminToken, {
        name: '客户C2',
        email: 'contact-c@tenant-c.test',
      });
      expect(res.status).toBe(409);

      const after = await app.inject({
        method: 'GET',
        url: '/api/customers',
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      expect((CustomersListResponseSchema.parse(after.json())).customers.length).toBe(beforeCount);
    });

    it('非超管（internal）创建 → 403', async () => {
      const res = await createCustomer(internalToken, {
        name: '客户D',
        email: 'd@tenant-d.test',
      });
      expect(res.status).toBe(403);
    });
  });

  describe('验收 ③④：invite-info 与邮箱绑定激活', () => {
    let customerInviteUrl: string;
    let customerToken: string;

    it('创建客户获得链接 → invite-info 返回 {kind: customer, email}', async () => {
      const res = await createCustomer(superAdminToken, {
        name: '客户E',
        email: 'contact-e@tenant-e.test',
      });
      expect(res.status).toBe(201);
      customerInviteUrl = (CustomerCreateResponseSchema.parse(res.body)).inviteUrl;
      customerToken = extractToken(customerInviteUrl);

      const info = await inviteInfo(customerToken);
      expect(info.status).toBe(200);
      const parsed = InviteInfoResponseSchema.safeParse(info.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.kind).toBe('customer');
      expect(parsed.data!.email).toBe('contact-e@tenant-e.test');
    });

    it('set-password 邮箱与绑定不一致 → 400', async () => {
      const status = await setPassword(customerToken, { email: 'wrong@tenant-e.test' });
      expect(status).toBe(400);
      // 未激活成功：invite-info 仍有效
      const info = await inviteInfo(customerToken);
      expect(info.status).toBe(200);
    });

    it('set-password 不传邮箱 → 400（客户邀请邮箱必填）', async () => {
      const status = await setPassword(customerToken, {});
      expect(status).toBe(400);
    });

    it('set-password 邮箱一致 → 激活成功；token 一次性（再次使用 400）', async () => {
      const ok = await setPassword(customerToken, { email: 'contact-e@tenant-e.test' });
      expect(ok).toBe(200);
      const again = await setPassword(customerToken, { email: 'contact-e@tenant-e.test' });
      expect(again).toBe(400);
      const info = await inviteInfo(customerToken);
      expect(info.status).toBe(400);
    });
  });

  describe('验收 ⑤：激活账号可登录且归属该客户', () => {
    it('登录成功，角色 customer，列表只见所属客户（RLS）', async () => {
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'contact-e@tenant-e.test', password },
      });
      expect(login.statusCode).toBe(200);
      const loginBody = login.json() as { user: { role: string } };
      expect(loginBody.user.role).toBe('customer_pm');

      const list = await app.inject({
        method: 'GET',
        url: '/api/customers',
        headers: { authorization: `Bearer ${(login.json() as { accessToken: string }).accessToken}` },
      });
      const customers = (CustomersListResponseSchema.parse(list.json())).customers;
      expect(customers).toHaveLength(1);
      expect(customers[0].name).toBe('客户E');
    });
  });

  describe('验收 ⑥：项目成员邀请回归 + 激活账号直接加成员', () => {
    let projectId: string;

    it('内部建项目，项目邀请 → invite-info 返回 {kind: project}，设密无需邮箱', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { name: 'P-E1', tenantId: (await listCustomerId()) },
      });
      expect(created.statusCode).toBe(201);
      projectId = ProjectCreateResponseSchema.parse(created.json()).project.id;

      const invited = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/members`,
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { email: 'new-user@tenant-e.test', role: 'customer_user' },
      });
      expect(invited.statusCode).toBe(201);
      const parsed = MemberInviteResponseSchema.safeParse(invited.json());
      expect(parsed.success).toBe(true);
      const token = extractToken(parsed.data!.inviteUrl!);

      const info = await inviteInfo(token);
      const infoParsed = InviteInfoResponseSchema.safeParse(info.body);
      expect(infoParsed.success).toBe(true);
      expect(infoParsed.data!.kind).toBe('project');

      // 项目邀请不带 email 照常激活
      expect(await setPassword(token, {})).toBe(200);
    });

    it('已激活的客户账号被邀请进项目 → 直接加入（inviteUrl=null）', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/members`,
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { email: 'contact-e@tenant-e.test', role: 'customer_key_user' },
      });
      expect(res.statusCode).toBe(201);
      const parsed = MemberInviteResponseSchema.safeParse(res.json());
      expect(parsed.success).toBe(true);
      expect(parsed.data!.inviteUrl).toBeNull();

      const list = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/members`,
        headers: { authorization: `Bearer ${internalToken}` },
      });
      const members = MembersListResponseSchema.parse(list.json());
      expect(members.members.map((m) => m.email)).toContain('contact-e@tenant-e.test');
    });

    async function listCustomerId(): Promise<string> {
      const res = await app.inject({
        method: 'GET',
        url: `/api/customers?search=${encodeURIComponent('客户E')}`,
        headers: { authorization: `Bearer ${superAdminToken}` },
      });
      return (CustomersListResponseSchema.parse(res.json())).customers[0].id;
    }
  });
});
