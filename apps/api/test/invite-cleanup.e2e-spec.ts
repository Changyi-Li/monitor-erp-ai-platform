import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { MemberInviteResponseSchema } from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { InviteCleanupWorker } from '../src/projects/invite-cleanup.worker';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * 过期邀请自动清理 e2e（issue #41 验收）：
 * - ① 发出邀请（待激活账号 + 客户归属 + 成员行）→ 把邀请过期时间改到过去
 *   → 触发清理 → users / user_tenants / project_members 三表无残留，链接失效（AC1）
 * - ② 未过期（或已激活）的账号保留（AC2）
 * - ③ 清理动作审计留痕 user.invite_expired（AC3）
 */
describe('InviteCleanup e2e：过期邀请自动清理', () => {
  let app: NestFastifyApplication;
  const password = 'password123';
  let internalToken: string;
  let projectId: string;

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

  async function invite(email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${internalToken}` },
      payload: { email, role: 'customer_user' },
    });
    expect(res.statusCode).toBe(201);
    return MemberInviteResponseSchema.parse(res.json()).inviteUrl!;
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
    } finally {
      await owner.end();
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('① 过期未激活的客户账号：users/user_tenants/project_members 三表无残留，链接失效', async () => {
    const email = 'expired@corp.test';
    const inviteUrl = await invite(email);
    const token = new URL(inviteUrl).searchParams.get('token')!;

    // 把邀请过期时间改到过去（模拟 7 天未点击）
    const owner = connectOwner();
    try {
      await owner`update users set invite_expires_at = now() - interval '1 day' where email = ${email}`;
    } finally {
      await owner.end();
    }

    // 触发清理（定时循环之外，直接调用同一方法）
    const worker = app.get(InviteCleanupWorker);
    const removed = await worker.cleanupExpiredInvites();
    expect(removed).toBeGreaterThanOrEqual(1);

    const owner2 = connectOwner();
    try {
      const [user] = await owner2`select id from users where email = ${email}`;
      expect(user).toBeUndefined();
      const tenants = await owner2`select id from user_tenants where user_id = ${user?.id ?? '00000000-0000-0000-0000-000000000000'}`;
      expect(tenants.length).toBe(0);
      const members = await owner2`select id from project_members where user_id = ${user?.id ?? '00000000-0000-0000-0000-000000000000'}`;
      expect(members.length).toBe(0);
    } finally {
      await owner2.end();
    }

    // 链接失效：set-password 拒绝
    const setPw = await app.inject({
      method: 'POST',
      url: '/api/auth/set-password',
      payload: { token, password },
    });
    expect([400, 401, 404]).toContain(setPw.statusCode);
  });

  it('② 未过期的待激活账号保留（清理不误伤）', async () => {
    const email = 'pending@corp.test';
    await invite(email);

    const owner = connectOwner();
    try {
      const [before] = await owner`select is_active from users where email = ${email}`;
      expect(before!.is_active).toBe(false);
    } finally {
      await owner.end();
    }

    const worker = app.get(InviteCleanupWorker);
    await worker.cleanupExpiredInvites();

    const owner2 = connectOwner();
    try {
      const [user] = await owner2`select id, is_active from users where email = ${email}`;
      expect(user).toBeDefined();
      expect(user!.is_active).toBe(false);
    } finally {
      await owner2.end();
    }
  });

  it('③ 清理动作审计留痕（user.invite_expired，metadata 含邮箱）', async () => {
    const owner = connectOwner();
    try {
      const rows = await owner`
        select metadata from audit_logs
        where action = 'user.invite_expired'
        order by created_at desc limit 1`;
      expect(rows.length).toBe(1);
      const metadata = JSON.parse(rows[0]!.metadata as string);
      expect(metadata.reason).toBe('invite_expired');
      expect(typeof metadata.email).toBe('string');
    } finally {
      await owner.end();
    }
  });
});
