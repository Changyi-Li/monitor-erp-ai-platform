import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  MemberInviteResponseSchema,
  MembersListResponseSchema,
  SetPasswordResponseSchema,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * 成员列表分组 e2e（issue #42 验收）：
 * - ① 邀请新邮箱 → 待激活邀请组（email/displayName/role/invitedAt/expiresAt）AC1
 * - ② 客户点链接设密激活 → 从待激活移入真实成员组（完整闭环）AC2
 * - ③ 停用/启用成员 → 仍在真实成员组（真实成员内部状态）AC3
 * - ④ 重发邀请 → 仍待激活（token 刷新不影响分组）AC1
 * - ⑤ 客户 PM 可看本租户项目分组列表（权限语义不变）AC4
 */
describe('Members list e2e：真实成员 / 待激活邀请分组', () => {
  let app: NestFastifyApplication;
  const password = 'password123';
  let internalToken: string;
  let pmToken: string; // 客户项目经理
  let projectId: string;

  async function register(email: string): Promise<{ id: string; token: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password, displayName: email.split('@')[0] },
    });
    expect(res.statusCode).toBe(201);
    const { user } = res.json() as { user: { id: string } };
    return { id: user.id, token: await login(email) };
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

  async function invite(email: string, role = 'regular_user'): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { email, role },
    });
    expect(res.statusCode).toBe(201);
    return MemberInviteResponseSchema.parse(res.json()).inviteUrl!;
  }

  async function activate(inviteUrl: string): Promise<void> {
    const token = new URL(inviteUrl).searchParams.get('token')!;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/set-password',
      payload: { token, password },
    });
    expect(res.statusCode).toBe(200);
    expect(SetPasswordResponseSchema.safeParse(res.json()).success).toBe(true);
  }

  async function list(token: string) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return MembersListResponseSchema.parse(res.json());
  }

  beforeAll(async () => {
    await resetTestDb();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();

    internalToken = (await register('internal@corp.test')).token;

    const owner = connectOwner();
    try {
      const [customer] = await owner`insert into customers (name) values ('客户A') returning id`;
      const create = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { authorization: `Bearer ${internalToken}` },
        payload: { tenantId: customer!.id, name: '项目A' },
      });
      expect(create.statusCode).toBe(201);
      projectId = (create.json() as { project: { id: string } }).project.id;

      // 客户 PM：内部邀请 + 激活后以其视角看列表
      const pmInvite = await invite('pm@corp.test', 'project_manager');
      await activate(pmInvite);
      pmToken = await login('pm@corp.test');
    } finally {
      await owner.end();
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('① 邀请新邮箱 → 出现在待激活邀请组（含邀请/过期时间）', async () => {
    const inviteUrl = await invite('pending@corp.test');
    expect(inviteUrl).toContain('/invite?token=');

    const body = await list(internalToken);
    expect(body.members.length).toBe(1); // 仅 PM
    expect(body.pendingInvites.length).toBe(1);

    const pending = body.pendingInvites[0]!;
    expect(pending.email).toBe('pending@corp.test');
    expect(pending.displayName).toBe('pending');
    expect(pending.role).toBe('regular_user');
    expect(pending.userId).toBeTruthy();
    // 邀请时间 ≈ 现在，过期时间 ≈ +7 天（30s 容差）
    expect(Date.now() - Date.parse(pending.invitedAt)).toBeLessThan(30_000);
    const ttl = Date.parse(pending.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(6.9 * 24 * 3600_000);
    expect(ttl).toBeLessThan(7.1 * 24 * 3600_000);
  });

  it('② 客户点链接设密激活 → 从待激活移入真实成员组（闭环）', async () => {
    const inviteUrl = await invite('activate-me@corp.test');
    await activate(inviteUrl);

    const body = await list(internalToken);
    const member = body.members.find((m) => m.email === 'activate-me@corp.test');
    expect(member).toBeDefined();
    expect(member!.isActive).toBe(true);
    expect(body.pendingInvites.find((p) => p.email === 'activate-me@corp.test')).toBeUndefined();
  });

  it('③ 停用成员 → 仍属真实成员组（内部状态，不混入待激活）', async () => {
    const before = await list(internalToken);
    const member = before.members.find((m) => m.email === 'activate-me@corp.test')!;

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/members/${member.userId}`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { isActive: false },
    });
    expect(patch.statusCode).toBe(204);

    const after = await list(internalToken);
    const deactivated = after.members.find((m) => m.email === 'activate-me@corp.test');
    expect(deactivated).toBeDefined();
    expect(deactivated!.isActive).toBe(false);
    expect(after.pendingInvites.find((p) => p.email === 'activate-me@corp.test')).toBeUndefined();

    // 启用回来，恢复初始状态
    const re = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/members/${member.userId}`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { isActive: true },
    });
    expect(re.statusCode).toBe(204);
  });

  it('④ 重发邀请 → 仍待激活（token 刷新不影响分组）', async () => {
    await invite('resend@corp.test');
    const before = await list(internalToken);
    expect(before.pendingInvites.some((p) => p.email === 'resend@corp.test')).toBe(true);

    // 重发：同邮箱再次邀请 → 新链接（token 覆盖，旧链接失效——set-password 处已由 invite 重发逻辑保证）
    const resend = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { email: 'resend@corp.test', role: 'regular_user' },
    });
    expect(resend.statusCode).toBe(201);
    const newUrl = MemberInviteResponseSchema.parse(resend.json()).inviteUrl!;
    const newToken = new URL(newUrl).searchParams.get('token')!;
    expect(newToken).toBeTruthy();

    const after = await list(internalToken);
    const stillPending = after.pendingInvites.find((p) => p.email === 'resend@corp.test');
    expect(stillPending).toBeDefined();
    expect(after.members.find((m) => m.email === 'resend@corp.test')).toBeUndefined();
  });

  it('⑤ 客户 PM 可看本租户项目分组列表（权限语义不变）', async () => {
    const body = await list(pmToken);
    // PM 自己是真实成员；待激活分组与内部视角一致
    expect(body.members.some((m) => m.email === 'pm@corp.test')).toBe(true);
    expect(body.pendingInvites.some((p) => p.email === 'resend@corp.test')).toBe(true);
  });
});
