import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { RolesGuard } from './roles.guard';

function makeGuard(required: string[] | undefined, role: string | undefined) {
  const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
  const guard = new RolesGuard(reflector);
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ user: role ? { role } : undefined }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as never;
  return () => guard.canActivate(context);
}

describe('RolesGuard', () => {
  it('无 @Roles metadata → 放行', () => {
    expect(makeGuard(undefined, 'customer_user')()).toBe(true);
    expect(makeGuard([], 'customer_user')()).toBe(true);
  });

  it('角色匹配 → 放行', () => {
    expect(makeGuard(['internal', 'customer_user'], 'internal')()).toBe(true);
    expect(makeGuard(['customer_user'], 'customer_user')()).toBe(true);
  });

  it('super_admin 继承 internal（超管 = 内部全权限）', () => {
    expect(makeGuard(['internal'], 'super_admin')()).toBe(true);
    expect(makeGuard(['customer_user'], 'super_admin')()).toBe(true);
  });

  it('不匹配 → ForbiddenException', () => {
    expect(() => makeGuard(['super_admin'], 'internal')()).toThrow(ForbiddenException);
    expect(() => makeGuard(['super_admin', 'internal'], 'customer_user')()).toThrow(
      ForbiddenException,
    );
  });

  it('未登录（无 user）→ ForbiddenException', () => {
    expect(() => makeGuard(['internal'], undefined)()).toThrow(ForbiddenException);
  });
});
