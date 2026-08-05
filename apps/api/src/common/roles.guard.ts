import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { UserRole } from '@monitor/shared';
import { ROLES_KEY } from './roles.decorator';

/**
 * 全局平台角色 Guard（注册在 JwtAuthGuard 之后，纯 JWT 检查零 DB 查询）：
 * - 无 @Roles metadata → 放行（项目级权限在 service 层按成员表解析）
 * - super_admin 继承 internal（超管 = 内部全权限 + 平台管理，spec §2.1）
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: { role?: string } }>();
    const role = request.user?.role;
    if (role === 'super_admin') {
      return true;
    }
    if (role && (required as string[]).includes(role)) {
      return true;
    }
    throw new ForbiddenException('没有权限执行该操作');
  }
}
