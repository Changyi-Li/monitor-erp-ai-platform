import { describe, expect, it } from 'vitest';
import {
  InviteInfoResponseSchema,
  SetPasswordRequestSchema,
  SetPasswordResponseSchema,
} from '../src';

describe('set-password 契约', () => {
  it('接受合法请求（token + 密码）', () => {
    expect(SetPasswordRequestSchema.safeParse({ token: 'abc123', password: 'password123' }).success).toBe(true);
  });

  it('email 可选（issue #50：客户邀请必填，成员邀请可不传）', () => {
    expect(
      SetPasswordRequestSchema.safeParse({ token: 'abc123', password: 'password123', email: 'a@b.test' }).success,
    ).toBe(true);
    // 传了就必须合法
    expect(
      SetPasswordRequestSchema.safeParse({ token: 'abc123', password: 'password123', email: 'nope' }).success,
    ).toBe(false);
  });

  it('拒绝空 token 与短密码', () => {
    expect(SetPasswordRequestSchema.safeParse({ token: '', password: 'password123' }).success).toBe(false);
    expect(SetPasswordRequestSchema.safeParse({ token: 'abc', password: 'short' }).success).toBe(false);
  });

  it('响应恒为 { ok: true }', () => {
    expect(SetPasswordResponseSchema.safeParse({ ok: true }).success).toBe(true);
    expect(SetPasswordResponseSchema.safeParse({ ok: false }).success).toBe(false);
    expect(SetPasswordResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('invite-info 契约（issue #50）', () => {
  it('接受 customer / project 两类响应', () => {
    expect(InviteInfoResponseSchema.safeParse({ kind: 'customer', email: 'a@b.test' }).success).toBe(true);
    expect(InviteInfoResponseSchema.safeParse({ kind: 'project', email: 'a@b.test' }).success).toBe(true);
  });

  it('拒绝非法 kind / 邮箱', () => {
    expect(InviteInfoResponseSchema.safeParse({ kind: 'other', email: 'a@b.test' }).success).toBe(false);
    expect(InviteInfoResponseSchema.safeParse({ kind: 'customer', email: 'nope' }).success).toBe(false);
    expect(InviteInfoResponseSchema.safeParse({ kind: 'customer' }).success).toBe(false);
  });
});
