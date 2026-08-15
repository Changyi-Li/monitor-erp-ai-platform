import { describe, expect, it } from 'vitest';
import {
  ErrorResponseSchema,
  InviteUserRequestSchema,
  InviteUserResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutRequestSchema,
  LogoutResponseSchema,
  MeResponseSchema,
  RefreshRequestSchema,
  RefreshResponseSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  UserAdminSchema,
  UserSchema,
  type User,
  type UserAdmin,
} from '../src';

const validUuid = 'b1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const validIsoDate = '2026-08-05T02:30:00.000Z';

const validUser = {
  id: validUuid,
  email: 'alice@example.com',
  displayName: 'Alice',
  // #37 引入：描述可空（缺省无描述）
  description: null,
  role: 'internal',
  createdAt: validIsoDate,
} satisfies User;

describe('auth 契约：UserSchema', () => {
  it('接受合法用户对象', () => {
    expect(UserSchema.safeParse(validUser).success).toBe(true);
  });

  it('接受 RBAC 五态角色（super_admin/internal/客户三档），拒绝未知 role', () => {
    for (const role of [
      'super_admin',
      'internal',
      'customer_pm',
      'customer_key_user',
      'customer_user',
    ] as const) {
      expect(UserSchema.safeParse({ ...validUser, role }).success).toBe(true);
    }
    expect(UserSchema.safeParse({ ...validUser, role: 'customer' }).success).toBe(false);
    expect(UserSchema.safeParse({ ...validUser, role: 'admin' }).success).toBe(false);
  });

  it('拒绝非法 uuid / 日期 / 空 displayName', () => {
    expect(UserSchema.safeParse({ ...validUser, id: 'not-a-uuid' }).success).toBe(false);
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

describe('auth 契约：客户 PM 邀请本公司用户（T6）', () => {
  const validAdminUser: UserAdmin = {
    ...validUser,
    isActive: false,
    inviteKind: 'customer',
    // #54：所属客户（客户角色必带；内部/超管 = null）
    customerId: validUuid,
    customerName: 'mesongroup',
  };

  it('接受合法邀请请求（role 缺省 → customer_user）', () => {
    const result = InviteUserRequestSchema.safeParse({ email: 'bob@example.com' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe('customer_user');
    }
    expect(
      InviteUserRequestSchema.safeParse({
        email: 'bob@example.com',
        displayName: '  Bob  ',
        role: 'customer_key_user',
      }).success,
    ).toBe(true);
  });

  it('拒绝非法邮箱 / 超长昵称 / customer_pm 与内部档位', () => {
    expect(InviteUserRequestSchema.safeParse({ email: 'nope' }).success).toBe(false);
    expect(
      InviteUserRequestSchema.safeParse({ email: 'bob@example.com', displayName: 'x'.repeat(65) }).success,
    ).toBe(false);
    // PM 档只能由建客户/超管产生（T3），内部档位同理拒绝
    expect(
      InviteUserRequestSchema.safeParse({ email: 'bob@example.com', role: 'customer_pm' }).success,
    ).toBe(false);
    expect(
      InviteUserRequestSchema.safeParse({ email: 'bob@example.com', role: 'internal' }).success,
    ).toBe(false);
    expect(
      InviteUserRequestSchema.safeParse({ email: 'bob@example.com', role: 'customer' }).success,
    ).toBe(false);
  });

  it('邀请响应 = 链接 + 过期时间 + 管理列表项（UserAdminSchema 同构）', () => {
    const result = InviteUserResponseSchema.safeParse({
      inviteUrl: 'http://localhost:3000/invite?token=abc',
      expiresAt: validIsoDate,
      user: validAdminUser,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.user).toMatchObject({
        email: 'alice@example.com',
        isActive: false,
        inviteKind: 'customer',
      });
    }
    expect(
      InviteUserResponseSchema.safeParse({
        inviteUrl: 'not-a-url',
        expiresAt: validIsoDate,
        user: validAdminUser,
      }).success,
    ).toBe(false);
  });

  it('UserAdminSchema 接受 isActive + inviteKind + 所属客户（管理列表项）', () => {
    expect(UserAdminSchema.safeParse(validAdminUser).success).toBe(true);
    expect(UserAdminSchema.safeParse({ ...validAdminUser, inviteKind: 'project' }).success).toBe(false);
    // #54：内部账号无归属 → customerId/customerName 为 null（可空）
    expect(
      UserAdminSchema.safeParse({ ...validAdminUser, customerId: null, customerName: null })
        .success,
    ).toBe(true);
    expect(
      UserAdminSchema.safeParse({ ...validAdminUser, customerId: 'not-a-uuid' }).success,
    ).toBe(false);
  });
});
