import type { ProjectRole, UserRole } from './constants';

/**
 * 功能角色：权限矩阵的列（spec §2.4）。
 * - internal 覆盖实施/开发/售后/市场/销售（Phase 1 功能权限相同，组织标签）
 * - super_admin = 内部全权限 + 平台管理（RolesGuard 层实现 super_admin ⊇ internal）
 * - 客户侧角色为项目级（project_members.role）
 */
export const FUNCTIONAL_ROLES = [
  'super_admin',
  'internal',
  'project_manager',
  'key_user',
  'regular_user',
] as const;
export type FunctionalRole = (typeof FUNCTIONAL_ROLES)[number];

/** 平台权限点（Phase 1，spec §2.4 十项 + 本期强制的基础设施权限） */
export const PERMISSIONS = [
  'blueprint:view',
  'phase:view',
  'meeting:view',
  'issue:create',
  'issue:comment',
  'issue:manage',
  'customer:manage',
  'kb:edit',
  'manual:generate',
  'agent:use',
  // 基础设施权限（本期 API 强制生效）
  'project:create',
  'member:manage',
  'user:manage',
  'customer:create',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * 权限矩阵（spec §2.4）：功能 → 允许的角色集合。
 * 本期已强制：project:create / member:manage / user:manage / customer:create；
 * 其余（blueprint/phase/meeting/issue/kb/manual/agent）定义先行，后续模块复用 can()。
 */
export const PERMISSION_MATRIX: Record<Permission, readonly FunctionalRole[]> = {
  'blueprint:view': ['super_admin', 'internal', 'project_manager', 'key_user', 'regular_user'],
  'phase:view': ['super_admin', 'internal', 'project_manager', 'key_user', 'regular_user'],
  'meeting:view': ['super_admin', 'internal', 'project_manager', 'key_user', 'regular_user'],
  'issue:create': ['super_admin', 'internal', 'project_manager', 'key_user', 'regular_user'],
  'issue:comment': ['super_admin', 'internal', 'project_manager', 'key_user'],
  'issue:manage': ['super_admin', 'internal', 'project_manager'],
  'customer:manage': ['super_admin', 'internal'],
  'kb:edit': ['super_admin', 'internal'],
  'manual:generate': ['super_admin', 'internal'],
  'agent:use': ['super_admin', 'internal'],
  'project:create': ['super_admin', 'internal'],
  'member:manage': ['super_admin', 'internal', 'project_manager'],
  'user:manage': ['super_admin', 'internal'],
  'customer:create': ['super_admin'],
};

/** 角色是否拥有该权限。role 为 null（无成员关系/未解析）→ 无权限 */
export function can(
  role: FunctionalRole | UserRole | ProjectRole | null | undefined,
  permission: Permission,
): boolean {
  if (!role) {
    return false;
  }
  return PERMISSION_MATRIX[permission].includes(role as FunctionalRole);
}
