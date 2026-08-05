import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CustomerCreateRequestSchema,
  CustomerCreateResponseSchema,
  CustomerUpdateResponseSchema,
  CustomersListResponseSchema,
  type Customer,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * 客户与项目 e2e（issue #14 验收）：
 * - ① 超管建客户 → 内部建项目归属客户 → 客户/项目列表展示（#13 端点回归）
 * - ② 内部可编辑客户资料、搜索全部客户（名称/行业/地域）
 * - ③ 客户用户只见所属客户（列表经 RLS 过滤），编辑请求 403
 * - ④ 项目归属不可变更（无 PATCH /projects 端点——架构决策，ADR-0003）
 * - 审计：customer.update 写入 audit_logs
 */
describe('Customers e2e：客户资料编辑、搜索与只读边界', () => {
  let app: NestFastifyApplication;

  const password = 'password123';
  let internalToken: string;
  let superAdminToken: string;
  let customerAToken: string;
  let customerBToken: string;
  let cidA: string;
  let cidB: string;

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
    body: { name: string; industry?: string; region?: string },
  ): Promise<{ status: number; id: string | null }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/customers',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    if (res.statusCode !== 201) {
      return { status: res.statusCode, id: null };
    }
    const parsed = CustomerCreateResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, id: parsed.data!.customer.id };
  }

  async function listCustomers(
    token: string,
    search?: string,
  ): Promise<{ status: number; customers: Customer[] }> {
    const query = search ? `?search=${encodeURIComponent(search)}` : '';
    const res = await app.inject({
      method: 'GET',
      url: `/api/customers${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const parsed = CustomersListResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return { status: res.statusCode, customers: parsed.data!.customers };
  }

  async function patchCustomer(
    token: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/customers/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
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

    // 用户：register 默认 internal；admin 提升 super_admin；两个客户账号绑定租户
    const internal = await register('internal@corp.test');
    const admin = await register('admin@corp.test');
    const customerAUser = await register('a@tenant-a.test');
    const customerBUser = await register('b@tenant-b.test');
    internalToken = internal.token;

    const owner = connectOwner();
    try {
      await owner`update users set role = 'super_admin' where id = ${admin.id}`;
      await owner`update users set role = 'customer' where id in (${customerAUser.id}, ${customerBUser.id})`;
    } finally {
      await owner.end();
    }

    // 角色变更后重新登录（JWT 携带新角色声明）
    const relogin = async (email: string): Promise<string> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password },
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as { accessToken: string }).accessToken;
    };
    superAdminToken = await relogin('admin@corp.test');
    customerAToken = await relogin('a@tenant-a.test');
    customerBToken = await relogin('b@tenant-b.test');

    // 验收 ①：超管创建客户（含行业/地域基础资料）
    const a = await createCustomer(superAdminToken, {
      name: '客户A',
      industry: '制造业',
      region: '华东',
    });
    const b = await createCustomer(superAdminToken, {
      name: '客户B',
      industry: '零售',
      region: '华南',
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    cidA = a.id!;
    cidB = b.id!;

    // 客户账号绑定租户（唯一租户，ADR-0001）
    const owner2 = connectOwner();
    try {
      await owner2`insert into user_tenants (user_id, customer_id) values
        (${customerAUser.id}, ${cidA}), (${customerBUser.id}, ${cidB})`;
    } finally {
      await owner2.end();
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('验收 ①：建客户 → 建项目归属客户 → 列表展示', () => {
    it('内部用户建项目归属客户 → 客户/项目列表展示', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { tenantId: cidA, name: 'P-A1' },
      });
      expect(res.statusCode).toBe(201);
      // 项目列表可见该项目；客户列表仍可拉取（内部看全部）
      const projects = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { authorization: `Bearer ${internalToken}` },
      });
      expect(projects.statusCode).toBe(200);
      const body = projects.json() as { projects: { name: string }[] };
      expect(body.projects.map((p) => p.name)).toContain('P-A1');
      const { customers } = await listCustomers(internalToken);
      expect(customers.map((c) => c.name)).toContain('客户A');
    });
  });

  describe('验收 ②：内部编辑客户资料、搜索全部客户', () => {
    it('内部用户编辑客户资料 → 200，字段更新（部分更新语义）', async () => {
      const res = await patchCustomer(internalToken, cidA, { name: '客户A（改）' });
      expect(res.status).toBe(200);
      const parsed = CustomerUpdateResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.customer.name).toBe('客户A（改）');
      // 未传字段保持原值
      expect(parsed.data!.customer.industry).toBe('制造业');
      expect(parsed.data!.customer.region).toBe('华东');
    });

    it('超管可编辑（super_admin ⊇ internal）', async () => {
      const res = await patchCustomer(superAdminToken, cidB, { industry: '批发' });
      expect(res.status).toBe(200);
      const parsed = CustomerUpdateResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.customer.industry).toBe('批发');
    });

    it('industry/region 显式传 null → 清空', async () => {
      const res = await patchCustomer(internalToken, cidB, { industry: null });
      expect(res.status).toBe(200);
      const parsed = CustomerUpdateResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.customer.industry).toBeNull();
    });

    it('搜索全部客户：按名称/行业/地域命中', async () => {
      const byName = await listCustomers(internalToken, '客户A');
      expect(byName.customers.map((c) => c.name)).toEqual(['客户A（改）']);
      const byIndustry = await listCustomers(internalToken, '制造业');
      expect(byIndustry.customers.map((c) => c.name)).toEqual(['客户A（改）']);
      const byRegion = await listCustomers(internalToken, '华南');
      expect(byRegion.customers.map((c) => c.name)).toEqual(['客户B']);
    });

    it('搜索无结果 → 空数组；search 为空 → 全量', async () => {
      const none = await listCustomers(internalToken, '不存在的客户');
      expect(none.customers).toEqual([]);
      const all = await listCustomers(internalToken);
      expect(all.customers.map((c) => c.name).sort()).toEqual(['客户A（改）', '客户B']);
    });

    it('内部 PATCH 不存在的客户 → 404；非法 uuid → 400', async () => {
      const missing = await patchCustomer(internalToken, '00000000-0000-4000-8000-000000000000', {
        name: 'x',
      });
      expect(missing.status).toBe(404);
      const invalid = await patchCustomer(internalToken, 'not-a-uuid', { name: 'x' });
      expect(invalid.status).toBe(400);
    });
  });

  describe('验收 ③：客户用户只读边界', () => {
    it('客户 A 列表只见所属客户（RLS 过滤）', async () => {
      const { customers } = await listCustomers(customerAToken);
      expect(customers).toHaveLength(1);
      expect(customers[0].id).toBe(cidA);
    });

    it('客户 B 同样只见所属客户', async () => {
      const { customers } = await listCustomers(customerBToken);
      expect(customers).toHaveLength(1);
      expect(customers[0].id).toBe(cidB);
    });

    it('客户用户编辑请求 → 403（只读）', async () => {
      const res = await patchCustomer(customerAToken, cidA, { name: '越权改名' });
      expect(res.status).toBe(403);
      // 数据未被篡改
      const { customers } = await listCustomers(internalToken, '客户A');
      expect(customers[0].name).toBe('客户A（改）');
    });
  });

  describe('验收 ④：项目归属不可变更', () => {
    it('平台无 PATCH /api/projects/:id 端点（归属不可变更的架构决策）', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/00000000-0000-4000-8000-000000000000`,
        headers: { authorization: `Bearer ${superAdminToken}` },
        payload: { tenantId: cidB },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('审计', () => {
    it('customer.update 写入 audit_logs（含 actor 与资源）', async () => {
      const owner = connectOwner();
      try {
        const rows = await owner`
          select action, actor_role, resource_type, resource_id
          from audit_logs
          where action = 'customer.update'
          order by created_at
        `;
        expect(rows.length).toBeGreaterThanOrEqual(3);
        expect(rows[0].actor_role).toBe('internal');
        expect(rows[0].resource_type).toBe('customer');
        expect(rows[0].resource_id).toBe(cidA);
      } finally {
        await owner.end();
      }
    });
  });
});
