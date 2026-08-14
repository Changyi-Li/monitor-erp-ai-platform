import {
  CUSTOMER_INVITE_ROLES,
  isCustomerRole,
  type CustomerInviteRole,
  type UserRole,
} from '@monitor/shared';
import type { ProjectViewerRole } from '@monitor/contracts';

/** 平台角色显示名（spec §2.1；客户三档：客户项目经理/关键用户/普通用户） */
export const USER_ROLE_LABELS: Record<UserRole, string> = {
  super_admin: '超级管理员',
  internal: '内部用户',
  customer_pm: '客户项目经理',
  customer_key_user: '客户关键用户',
  customer_user: '客户普通用户',
};

/** 成员邀请可选档位（与后端契约同源；customer_pm 档只能由建客户/超管产生） */
export const INVITE_ROLES = CUSTOMER_INVITE_ROLES;

export function userRoleLabel(role: UserRole): string {
  return USER_ROLE_LABELS[role] ?? role;
}

export function inviteRoleLabel(role: CustomerInviteRole): string {
  return USER_ROLE_LABELS[role] ?? role;
}

/** 菜单/按钮显隐：内部（含超管）可见平台管理入口 */
export function isPlatformRole(role: UserRole | undefined): boolean {
  return role === 'super_admin' || role === 'internal';
}

export { isCustomerRole };

/**
 * 成员管理入口显隐：内部（含超管）或该项目成员中的客户项目经理
 * （T2：管理资格 = 平台角色 customer_pm，权限判定完全基于平台角色）
 */
export function canManageMembers(viewerRole: ProjectViewerRole): boolean {
  return viewerRole === 'internal' || viewerRole === 'customer_pm';
}
