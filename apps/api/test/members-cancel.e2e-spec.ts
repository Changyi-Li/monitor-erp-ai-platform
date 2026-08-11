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
 * 取消/重发邀请 e2e（issue #43 验收）：
 * - ① 重发 → 旧链接失效（设密 400）、新链接可激活（验收 2）
 * - ② 取消 → 账号删除（users 无记录，租户/成员级联清除）、旧链接失效（验收 3）
 * - ③ 客户 PM 取消 project_manager 角色邀请 → 403；内部可取消（验收 4）
 */
describe('Members e2e：重发 / 取消邀请', () => {
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

  /** 用链接里的 token 尝试设密激活；返回 HTTP 状态码 */
  async function tryActivate(inviteUrl: string): Promise<number> {
    const token = new URL(inviteUrl).searchParams.get('token')!;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/set-password',
      payload: { token, password },
    });
    return res.statusCode;
  }

  async function cancel(token: string, userId: string): Promise<number> {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/members/${userId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return res.statusCode;
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

      // 客户 PM：内部邀请 + 激活
      const pmInvite = await invite('pm@corp.test', 'project_manager');
      expect(await tryActivate(pmInvite)).toBe(200);
      pmToken = await login('pm@corp.test');
    } finally {
      await owner.end();
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('① 重发邀请 → 旧链接失效（设密 400），新链接可激活', async () => {
    const oldUrl = await invite('resend-activate@corp.test');
    const resend = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { email: 'resend-activate@corp.test', role: 'regular_user' },
    });
    expect(resend.statusCode).toBe(201);
    const newUrl = MemberInviteResponseSchema.parse(resend.json()).inviteUrl!;
    expect(newUrl).not.toBe(oldUrl);

    // 旧链接设密 → 400 链接无效；新链接 → 200 激活成功
    expect(await tryActivate(oldUrl)).toBe(400);
    expect(await tryActivate(newUrl)).toBe(200);

    // 激活后从待激活移入真实成员
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    const body = MembersListResponseSchema.parse(list.json());
    expect(body.pendingInvites.find((p) => p.email === 'resend-activate@corp.test')).toBeUndefined();
    expect(body.members.some((m) => m.email === 'resend-activate@corp.test')).toBe(true);
  });

  it('② 取消邀请 → 账号删除（users/租户/成员级联清除），旧链接失效', async () => {
    const inviteUrl = await invite('cancel-me@corp.test');

    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    const pending = MembersListResponseSchema.parse(list.json()).pendingInvites.find(
      (p) => p.email === 'cancel-me@corp.test',
    )!;

    expect(await cancel(internalToken, pending.userId)).toBe(204);
    // 链接失效：设密 400
    expect(await tryActivate(inviteUrl)).toBe(400);

    const owner = connectOwner();
    try {
      const [user] = await owner`select id from users where id = ${pending.userId}`;
      expect(user).toBeUndefined();
      const [tenant] = await owner`select id from user_tenants where user_id = ${pending.userId}`;
      expect(tenant).toBeUndefined();
      const [member] = await owner`select id from project_members where user_id = ${pending.userId}`;
      expect(member).toBeUndefined();
    } finally {
      await owner.end();
    }

    // 列表里待激活分组消失
    const after = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    const body = MembersListResponseSchema.parse(after.json());
    expect(body.pendingInvites.find((p) => p.email === 'cancel-me@corp.test')).toBeUndefined();
  });

  it('③ 客户 PM 取消 project_manager 角色邀请 → 403；内部可取消 → 204', async () => {
    const inviteUrl = await invite('pm-invite@corp.test', 'project_manager');
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    const pending = MembersListResponseSchema.parse(list.json()).pendingInvites.find(
      (p) => p.email === 'pm-invite@corp.test',
    )!;

    // 客户 PM 取消被拒（403），邀请保留
    expect(await cancel(pmToken, pending.userId)).toBe(403);
    // 客户 PM 重发也被拒（403）——用 regular_user 冒充 body.role 也应被按成员行角色拦截
    const resendByPm = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${pmToken}` },
      payload: { email: 'pm-invite@corp.test', role: 'regular_user' },
    });
    expect(resendByPm.statusCode).toBe(403);
    const still = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    expect(
      MembersListResponseSchema.parse(still.json()).pendingInvites.some(
        (p) => p.email === 'pm-invite@corp.test',
      ),
    ).toBe(true);

    // 内部取消 → 204，链接失效
    expect(await cancel(internalToken, pending.userId)).toBe(204);
    expect(await tryActivate(inviteUrl)).toBe(400);
  });

  it('④ 对已激活成员执行取消 → 409（不能取消，走停用）', async () => {
    // pm@corp.test 是已激活成员
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${internalToken}` },
    });
    const pm = MembersListResponseSchema.parse(list.json()).members.find(
      (m) => m.email === 'pm@corp.test',
    )!;
    expect(await cancel(internalToken, pm.userId)).toBe(409);
    // 账号还在
    const owner = connectOwner();
    try {
      const [user] = await owner`select id from users where id = ${pm.userId}`;
      expect(user).toBeDefined();
    } finally {
      await owner.end();
    }
  });
});
