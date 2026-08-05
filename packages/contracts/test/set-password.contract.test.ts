import { describe, expect, it } from 'vitest';
import { SetPasswordRequestSchema, SetPasswordResponseSchema } from '../src';

describe('set-password 契约', () => {
  it('接受合法请求（token + 密码）', () => {
    expect(SetPasswordRequestSchema.safeParse({ token: 'abc123', password: 'password123' }).success).toBe(true);
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
