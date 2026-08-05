import type { INestApplication } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  ErrorResponseSchema,
  LoginResponseSchema,
  MeResponseSchema,
  RefreshResponseSchema,
  RegisterResponseSchema,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { resetTestDb } from './setup-test-db';

/**
 * 每个响应断言两步走：HTTP 状态码 + 契约校验（响应契约由 e2e 独立复核）。
 * 注：supertest 与 Fastify 5 存在兼容问题（preParsing hooks），统一用 Fastify 原生 app.inject()。
 */
describe('Auth API e2e', () => {
  let app: NestFastifyApplication;

  const email = 'e2e@example.com';
  const password = 'password123';
  let userId: string;
  let accessToken: string;
  let refreshToken: string;

  async function post<T = Record<string, unknown>>(
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: T }> {
    const res = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: payload as Record<string, unknown>,
    });
    return { status: res.statusCode, body: res.json() as T };
  }

  beforeAll(async () => {
    await resetTestDb();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    // 与 src/main.ts 保持一致（e2e 不走 main.ts bootstrap）
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('注册', () => {
    it('注册成功 201，响应通过 RegisterResponseSchema', async () => {
      const { status, body } = await post<{ user: { id: string } }>(
        '/api/auth/register',
        { email, password, displayName: 'E2E User' },
      );
      expect(status).toBe(201);
      expect(RegisterResponseSchema.safeParse(body).success).toBe(true);
      userId = body.user.id;
    });

    it('重复邮箱注册 → 409', async () => {
      const { status } = await post('/api/auth/register', { email, password });
      expect(status).toBe(409);
    });

    it('非法邮箱 / 短密码 → 400（ZodValidationPipe 生效）', async () => {
      const badEmail = await post('/api/auth/register', {
        email: 'not-an-email',
        password: 'password123',
      });
      expect(badEmail.status).toBe(400);
      const shortPassword = await post('/api/auth/register', {
        email: 'x@example.com',
        password: 'short',
      });
      expect(shortPassword.status).toBe(400);
    });
  });

  describe('登录', () => {
    it('登录成功 200，响应通过 LoginResponseSchema，email 小写化一致，expiresIn > 0', async () => {
      const { status, body } = await post<{
        user: { id: string; email: string };
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
      }>('/api/auth/login', { email: email.toUpperCase(), password });
      expect(status).toBe(200);
      expect(LoginResponseSchema.safeParse(body).success).toBe(true);
      expect(body.user.email).toBe(email);
      expect(body.user.id).toBe(userId);
      expect(body.expiresIn).toBeGreaterThan(0);
      accessToken = body.accessToken;
      refreshToken = body.refreshToken;
    });

    it('错误密码 / 不存在邮箱 → 401（同一文案，防枚举）', async () => {
      const wrongPassword = await post<{ message: string }>(
        '/api/auth/login',
        { email, password: 'wrong-password' },
      );
      const missingUser = await post<{ message: string }>(
        '/api/auth/login',
        { email: 'nobody@example.com', password },
      );
      expect(wrongPassword.status).toBe(401);
      expect(missingUser.status).toBe(401);
      expect(wrongPassword.body.message).toBe(missingUser.body.message);
    });
  });

  describe('me', () => {
    it('带 Bearer token → 200，user.id 与登录一致', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        user: { id: string; email: string };
      };
      expect(MeResponseSchema.safeParse(body).success).toBe(true);
      expect(body.user.id).toBe(userId);
      expect(body.user.email).toBe(email);
      // 契约一致性：me 返回的 user 与登录返回的 user 同构
      expect(LoginResponseSchema.shape.user.safeParse(body.user).success).toBe(true);
    });

    it('无 token / 伪造 token → 401（Guard 生效）', async () => {
      const noToken = await app.inject({ method: 'GET', url: '/api/auth/me' });
      expect(noToken.statusCode).toBe(401);
      const fakeToken = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: 'Bearer not-a-real-token' },
      });
      expect(fakeToken.statusCode).toBe(401);
    });
  });

  describe('refresh 轮换', () => {
    it('旧 refreshToken 刷新 → 200 新令牌对；旧 token 再刷新 → 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: { refreshToken },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        accessToken: string;
        refreshToken: string;
      };
      expect(RefreshResponseSchema.safeParse(body).success).toBe(true);
      expect(body.accessToken).toBeTruthy();
      expect(body.refreshToken).not.toBe(refreshToken);

      const stale = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: { refreshToken },
      });
      expect(stale.statusCode).toBe(401);
      expect(ErrorResponseSchema.safeParse(stale.json()).success).toBe(true);

      refreshToken = body.refreshToken;
      accessToken = body.accessToken;
    });
  });

  describe('登出即失效（验收核心）', () => {
    it('logout → 204；该 refreshToken 刷新 → 401；logout 幂等', async () => {
      const logoutToken = refreshToken;
      const logout = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { refreshToken: logoutToken },
      });
      expect(logout.statusCode).toBe(204);

      const afterLogout = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: { refreshToken: logoutToken },
      });
      expect(afterLogout.statusCode).toBe(401);
      expect(ErrorResponseSchema.safeParse(afterLogout.json()).success).toBe(true);

      // 幂等：再次 logout 仍 204
      const again = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { refreshToken: logoutToken },
      });
      expect(again.statusCode).toBe(204);
    });
  });
});
