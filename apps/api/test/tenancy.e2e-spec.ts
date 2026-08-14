import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  ErrorResponseSchema,
  ProjectGetResponseSchema,
  ProjectsListResponseSchema,
} from '@monitor/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * 多租户隔离红线 e2e：
 * - API 层：客户 A 只见自己租户的项目，内部用户见全部（demo path）
 * - DB 层：受限角色 app_tenant_user（非 owner、无 BYPASSRLS）连接，
 *   SET LOCAL GUC 驱动的 RLS 在无应用层时同样生效（兜底验证）
 * 注意：应用连接（.env.test DATABASE_URL）本身就是受限角色——
 * 表 owner 默认绕过 RLS，应用不以受限角色连则本套件无意义。
 */
describe('Tenancy e2e：多租户 RLS 隔离', () => {
  let app: NestFastifyApplication;

  const password = 'password123';
  let customerAToken: string;
  let internalToken: string;
  let customerCNoMembershipToken: string;
  let cidA: string;
  let cidB: string;
  let projectA1Id: string;
  let projectB1Id: string;

  async function register(email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password, displayName: email.split('@')[0] },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { user: { id: string } }).user.id;
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

  async function getProjects(token: string): Promise<{ status: number; body: unknown }> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: res.json() };
  }

  async function getProject(token: string, id: string): Promise<{ status: number; body: unknown }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: res.json() };
  }

  beforeAll(async () => {
    await resetTestDb();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api');
    await app.init();

    // 用户：默认 role=internal；客户用户经 owner 连接改为 customer 并建成员关系
    const userIdA = await register('a@tenant-a.test');
    const userIdB = await register('b@tenant-b.test');
    const userIdInternal = await register('internal@corp.test');
    const userIdC = await register('c@no-membership.test');

    const owner = connectOwner();
    try {
      await owner`update users set role = 'customer_user' where id in (${userIdA}, ${userIdB}, ${userIdC})`;
      const [customerA] = await owner`insert into customers (name) values ('客户A') returning id`;
      const [customerB] = await owner`insert into customers (name) values ('客户B') returning id`;
      cidA = customerA.id as string;
      cidB = customerB.id as string;
      await owner`insert into user_tenants (user_id, customer_id) values (${userIdA}, ${cidA}), (${userIdB}, ${cidB})`;
      const [a1] = await owner`insert into projects (tenant_id, name) values (${cidA}, 'A1') returning id`;
      const [a2] = await owner`insert into projects (tenant_id, name) values (${cidA}, 'A2') returning id`;
      // 同租户无成员关系项目 A3（RBAC #13：跨项目访问 → 403）
      await owner`insert into projects (tenant_id, name) values (${cidA}, 'A3')`;
      const [b1] = await owner`insert into projects (tenant_id, name) values (${cidB}, 'B1') returning id`;
      projectA1Id = a1.id as string;
      projectB1Id = b1.id as string;
      // RBAC #13：客户 A 的可见范围 = active 成员项目（A1 / A2 两个成员行）
      await owner`insert into project_members (project_id, user_id) values
        (${a1.id}, ${userIdA}), (${a2.id}, ${userIdA})`;
    } finally {
      await owner.end();
    }

    customerAToken = await login('a@tenant-a.test');
    internalToken = await login('internal@corp.test');
    customerCNoMembershipToken = await login('c@no-membership.test');
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('API 层：客户 A 隔离', () => {
    it('客户 A 列表只见自己的项目（A1/A2）', async () => {
      const { status, body } = await getProjects(customerAToken);
      expect(status).toBe(200);
      expect(ProjectsListResponseSchema.safeParse(body).success).toBe(true);
      const projects = (body as { projects: { id: string; name: string }[] }).projects;
      expect(projects.map((p) => p.name).sort()).toEqual(['A1', 'A2']);
      expect(projects.every((p) => p.tenantId === cidA)).toBe(true);
    });

    it('客户 A 访问客户 B 的项目 → 404（非 403，防存在性探测）', async () => {
      const { status, body } = await getProject(customerAToken, projectB1Id);
      expect(status).toBe(404);
      expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
    });

    it('客户 A 访问同租户非成员项目 A3 → 403（跨项目访问，RBAC #13）', async () => {
      // A3 是客户 A 租户内但非成员 → 详情接口返回 403（同租户跨项目）
      const owner = connectOwner();
      try {
        const [a3] = await owner`select id from projects where name = 'A3'`;
        const { status, body } = await getProject(customerAToken, a3.id as string);
        expect(status).toBe(403);
        expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
      } finally {
        await owner.end();
      }
    });

    it('客户 A 访问自己的项目 → 200（viewerRole 为成员角色）', async () => {
      const { status, body } = await getProject(customerAToken, projectA1Id);
      expect(status).toBe(200);
      const parsed = ProjectGetResponseSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.viewerRole).toBe('customer_user');
    });

    it('非法 uuid → 400（避免 22P02 → 500）', async () => {
      const { status } = await getProject(customerAToken, 'not-a-uuid');
      expect(status).toBe(400);
    });

    it('无成员关系的客户用户 → 空列表（fail closed 哨兵）', async () => {
      const { status, body } = await getProjects(customerCNoMembershipToken);
      expect(status).toBe(200);
      const projects = (body as { projects: unknown[] }).projects;
      expect(projects).toEqual([]);
    });
  });

  describe('API 层：内部用户旁路', () => {
    it('内部用户列表见全部 4 个项目，含 B1 与 A3', async () => {
      const { status, body } = await getProjects(internalToken);
      expect(status).toBe(200);
      const projects = (body as { projects: { name: string }[] }).projects;
      expect(projects.map((p) => p.name).sort()).toEqual(['A1', 'A2', 'A3', 'B1']);
    });

    it('内部用户访问任意租户项目 → 200', async () => {
      const { status, body } = await getProject(internalToken, projectB1Id);
      expect(status).toBe(200);
      expect(ProjectGetResponseSchema.safeParse(body).success).toBe(true);
    });
  });

  describe('DB 层：受限角色连接 RLS 兜底（acceptance ③）', () => {
    it('受限角色无 GUC → 0 行（fail closed）', async () => {
      const client = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        const rows = await client`select * from projects`;
        expect(rows.length).toBe(0);
      } finally {
        await client.end();
      }
    });

    it('SET LOCAL app.tenant_id=客户A → 只见租户 A 全部 3 个项目（RLS 客户级，项目边界在应用层）', async () => {
      const client = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        await client.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${cidA}, true)`;
          const rows = await tx`select name from projects order by name`;
          expect(rows.map((r) => r.name)).toEqual(['A1', 'A2', 'A3']);
        });
      } finally {
        await client.end();
      }
    });

    it('SET LOCAL app.is_internal=true → 全部 4 行', async () => {
      const client = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        await client.begin(async (tx) => {
          await tx`select set_config('app.is_internal', 'true', true)`;
          const rows = await tx`select name from projects order by name`;
          expect(rows.map((r) => r.name)).toEqual(['A1', 'A2', 'A3', 'B1']);
        });
      } finally {
        await client.end();
      }
    });

    it('SET LOCAL 提交后的 GUC 空串残留不触发 22P02（fail closed）', async () => {
      // PG 怪癖：自定义 GUC 经 SET LOCAL 提交后会话值残留 ''（非 NULL），
      // ''::uuid 会报 22P02；策略用 NULLIF 归一后应返回 0 行而非报错
      const client = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        await client.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${cidA}, true)`;
        });
        const rows = await client`select * from projects`;
        expect(rows.length).toBe(0);
      } finally {
        await client.end();
      }
    });

    it('受限角色确为非 owner、无 BYPASSRLS', async () => {
      const client = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        const [role] = await client`
          select rolsuper, rolbypassrls from pg_roles where rolname = 'app_tenant_user'
        `;
        expect(role.rolsuper).toBe(false);
        expect(role.rolbypassrls).toBe(false);
      } finally {
        await client.end();
      }
    });

    it('客户角色 INSERT 他租户项目 → withCheck 拒绝', async () => {
      const client = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        await expect(
          client.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${cidA}, true)`;
            await tx`insert into projects (tenant_id, name) values (${cidB}, 'X')`;
          }),
        ).rejects.toThrow();
      } finally {
        await client.end();
      }
    });

    it('customers 注册表：租户 GUC → 只见自己的客户行', async () => {
      const client = postgres(process.env.DATABASE_URL!, { max: 1 });
      try {
        await client.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${cidA}, true)`;
          const rows = await tx`select id, name from customers`;
          expect(rows).toEqual([{ id: cidA, name: '客户A' }]);
        });
      } finally {
        await client.end();
      }
    });
  });
});
