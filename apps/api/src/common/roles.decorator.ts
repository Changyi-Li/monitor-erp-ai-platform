import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@monitor/shared';

export const ROLES_KEY = 'roles';

/**
 * 平台粗粒度角色守卫（配合 RolesGuard）。用于用户/客户/项目管理等平台级端点；
 * 项目级权限（member:manage 等）在 service 层按成员表解析，不在此列。
 * 未标注 @Roles 的路由放行（默认只要求登录）。
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
