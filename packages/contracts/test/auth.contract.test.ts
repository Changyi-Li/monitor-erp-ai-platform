import { describe, expect, it } from 'vitest';
import {
  ErrorResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutRequestSchema,
  LogoutResponseSchema,
  MeResponseSchema,
  RefreshRequestSchema,
  RefreshResponseSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  UserSchema,
  type User,
} from '../src';

const validUuid = 'b1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const validIsoDate = '2026-08-05T02:30:00.000Z';

const validUser = {
  id: validUuid,
  email: 'alice@example.com',
  displayName: 'Alice',
  role: 'internal',
  createdAt: validIsoDate,
} satisfies User;

describe('auth 契约：UserSchema', () => {
  it('接受合法用户对象', () => {
    expect(UserSchema.safeParse(validUser).success).toBe(true);
  });

  it('拒绝非法 uuid / role / 日期 / 空 displayName', () => {
    expect(UserSchema.safeParse({ ...validUser, id: 'not-a-uuid' }).success).toBe(false);
    expect(UserSchema.safeParse({ ...validUser, role: 'admin' }).success).toBe(false);
    expect(UserSchema.safeParse({ ...validUser, createdAt: '2026-13-99' }).success).toBe(false);
    expect(UserSchema.safeParse({ ...validUser, displayName: '  ' }).success).toBe(false);
  });
});

describe('auth 契约：注册', () => {
  it('接受合法注册请求', () => {
    const result = RegisterRequestSchema.safeParse({
      email: 'alice@example.com',
      password: 'password123',
    });
    expect(result.success).toBe(true);
  });

  it('接受可选 displayName 与 trim', () => {
    const result = RegisterRequestSchema.safeParse({
      email: 'alice@example.com',
      password: 'password123',
      displayName: '  Alice  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.displayName).toBe('Alice');
    }
  });

  it('拒绝非法邮箱与短密码', () => {
    expect(RegisterRequestSchema.safeParse({ email: 'not-an-email', password: 'password123' }).success).toBe(false);
    expect(RegisterRequestSchema.safeParse({ email: 'alice@example.com', password: 'short' }).success).toBe(false);
  });

  it('注册响应为 { user }', () => {
    expect(
      RegisterResponseSchema.safeParse({ user: validUser }).success,
    ).toBe(true);
  });
});

describe('auth 契约：登录', () => {
  it('接受合法登录请求', () => {
    expect(LoginRequestSchema.safeParse({ email: 'alice@example.com', password: 'x' }).success).toBe(true);
  });

  it('拒绝非法邮箱', () => {
    expect(LoginRequestSchema.safeParse({ email: 'nope', password: 'x' }).success).toBe(false);
  });

  it('登录响应含令牌与 expiresIn', () => {
    const result = LoginResponseSchema.safeParse({
      user: validUser,
      accessToken: 'a.b.c',
      refreshToken: 'r1',
      expiresIn: 900,
    });
    expect(result.success).toBe(true);
    expect(LoginResponseSchema.safeParse({ ...result.data, expiresIn: 0 }).success).toBe(false);
  });
});

describe('auth 契约：刷新与登出', () => {
  it('刷新请求/响应', () => {
    expect(RefreshRequestSchema.safeParse({ refreshToken: '' }).success).toBe(false);
    expect(RefreshRequestSchema.safeParse({ refreshToken: 'rt' }).success).toBe(true);
    expect(
      RefreshResponseSchema.safeParse({ accessToken: 'a', refreshToken: 'b', expiresIn: 900 }).success,
    ).toBe(true);
  });

  it('登出请求非空；响应为 204（undefined）', () => {
    expect(LogoutRequestSchema.safeParse({ refreshToken: 'rt' }).success).toBe(true);
    expect(LogoutRequestSchema.safeParse({}).success).toBe(false);
    expect(LogoutResponseSchema.safeParse(undefined).success).toBe(true);
    expect(LogoutResponseSchema.safeParse(null).success).toBe(false);
  });
});

describe('auth 契约：me 与跨契约一致性', () => {
  it('me 响应为 { user }', () => {
    expect(MeResponseSchema.safeParse({ user: validUser }).success).toBe(true);
  });

  it('登录返回的 user 与 me 返回的 user 同构（UserSchema 唯一事实源）', () => {
    const loginUser = LoginResponseSchema.shape.user;
    const meUser = MeResponseSchema.shape.user;
    // 两侧都能解析同一个合法 user 对象
    expect(loginUser.safeParse(validUser).success).toBe(true);
    expect(meUser.safeParse(validUser).success).toBe(true);
  });
});

describe('auth 契约：错误响应对齐 Nest 异常体', () => {
  it('解析字符串与数组 message', () => {
    expect(ErrorResponseSchema.safeParse({ statusCode: 409, message: '该邮箱已注册' }).success).toBe(true);
    expect(
      ErrorResponseSchema.safeParse({ statusCode: 400, message: ['邮箱格式不正确'], error: 'Bad Request' }).success,
    ).toBe(true);
    expect(ErrorResponseSchema.safeParse({ message: '缺 statusCode' }).success).toBe(false);
  });
});
