import { USER_ROLES, type UserRole } from './constants';

/**
 * 功能角色：权限矩阵的列（spec §2.4）。角色拆分后（T1/T2）权限判定完全基于
 * 平台角色——内部侧为 super_admin / internal（RolesGuard 层实现 super_admin ⊇
 * internal），客户侧为 customer_pm / customer_key_user / customer_user；
 * project_members.role 已退役（迁移 0020），不再有项目级角色维度。
 */
export const FUNCTIONAL_ROLES = USER_ROLES;
export type FunctionalRole = UserRole;

/** 平台权限点（Phase 1，spec §2.4 十项 + 本期强制的基础设施权限） */
export const PERMISSIONS = [
  'blueprint:view',
  'blueprint:manage',
  'phase:view',
  'phase:manage',
  'risk:manage',
  'meeting:view',
  'meeting:manage',
  'issue:create',
  'issue:comment',
  'issue:manage',
  'issue:transition',
  'customer:manage',
  'kb:edit',
  'manual:generate',
  'agent:use',
  'rag:view', // #21 RAG 同步状态/调试台（spec 用户故事 50 内部用户查看）
  // 基础设施权限（本期 API 强制生效）
  'project:create',
  'member:manage',
  'user:manage',
  'customer:create',
  'customer:update',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * 权限矩阵（spec §2.4）：功能 → 允许的平台角色集合。
 * 本期已强制：project:create / member:manage / user:manage / customer:create /
 * blueprint:view + blueprint:manage（#16 蓝图，维护仅内部）；
 * phase:view + phase:manage + risk:manage（#17 实施阶段/风险，维护仅内部）；
 * 其余（meeting/issue/kb/manual/agent）定义先行，后续模块复用 can()。
 */
export const PERMISSION_MATRIX: Record<Permission, readonly FunctionalRole[]> = {
  'blueprint:view': ['super_admin', 'internal', 'customer_pm', 'customer_key_user', 'customer_user'],
  'blueprint:manage': ['super_admin', 'internal'], // spec §2.4 蓝图维护仅内部/超管
  'phase:view': ['super_admin', 'internal', 'customer_pm', 'customer_key_user', 'customer_user'],
  'phase:manage': ['super_admin', 'internal'], // spec §2.4 line 81 阶段维护仅内部/超管
  'risk:manage': ['super_admin', 'internal'], // spec §2.4 line 81 风险维护仅内部/超管（查看同 phase:view）
  'meeting:view': ['super_admin', 'internal', 'customer_pm', 'customer_key_user', 'customer_user'],
  'meeting:manage': ['super_admin', 'internal'], // spec §2.4 会议纪要维护仅内部/超管（查看=meeting:view 全员）
  'issue:create': ['super_admin', 'internal', 'customer_pm', 'customer_key_user', 'customer_user'],
  'issue:comment': ['super_admin', 'internal', 'customer_pm', 'customer_key_user'],
  'issue:manage': ['super_admin', 'internal', 'customer_pm'],
  'issue:transition': ['super_admin', 'internal'],
  'customer:manage': ['super_admin', 'internal'],
  'kb:edit': ['super_admin', 'internal'],
  'manual:generate': ['super_admin', 'internal'],
  'agent:use': ['super_admin', 'internal'],
  'rag:view': ['super_admin', 'internal'], // #21 RAG 同步状态/调试台仅内部（spec 用户故事 50）
  'project:create': ['super_admin', 'internal'],
  'member:manage': ['super_admin', 'internal', 'customer_pm'], // 客户侧管理资格 = 平台角色 customer_pm（T2）
  'user:manage': ['super_admin', 'internal', 'customer_pm'], // 列表可见（T4 本公司账号）；停用/启用：超管任意 + customer_pm 本公司（T5）；其余写操作仍超管/本人
  'customer:create': ['super_admin'],
  'customer:update': ['super_admin', 'internal'],
};

/** 角色是否拥有该权限。role 为 null（无成员关系/未解析）→ 无权限 */
export function can(
  role: FunctionalRole | null | undefined,
  permission: Permission,
): boolean {
  if (!role) {
    return false;
  }
  return PERMISSION_MATRIX[permission].includes(role);
}
