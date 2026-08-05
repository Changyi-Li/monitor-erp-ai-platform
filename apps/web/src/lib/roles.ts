import type { ProjectRole, UserRole } from '@monitor/shared';
import type { ProjectViewerRole } from '@monitor/contracts';

/** 平台角色显示名（spec §2.1） */
export const USER_ROLE_LABELS: Record<UserRole, string> = {
  super_admin: '超级管理员',
  internal: '内部用户',
  customer: '客户用户',
};

/** 项目角色显示名 */
export const PROJECT_ROLE_LABELS: Record<ProjectRole, string> = {
  project_manager: '项目经理',
  key_user: 'Key User',
  regular_user: '普通用户',
};

export function userRoleLabel(role: UserRole): string {
  return USER_ROLE_LABELS[role] ?? role;
}

export function projectRoleLabel(role: ProjectRole): string {
  return PROJECT_ROLE_LABELS[role] ?? role;
}

/** 菜单/按钮显隐：内部（含超管）可见平台管理入口 */
export function isPlatformRole(role: UserRole | undefined): boolean {
  return role === 'super_admin' || role === 'internal';
}

/** 成员管理入口显隐：内部或该项目 PM */
export function canManageMembers(viewerRole: ProjectViewerRole): boolean {
  return viewerRole === 'internal' || viewerRole === 'project_manager';
}
