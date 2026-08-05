/**
 * 平台粗粒度角色（JWT 级，TenantInterceptor 以 role !== 'customer' 判定内部旁路）。
 * 客户用户的细粒度角色（PM/Key User/普通用户）按项目存 project_members，不进 JWT。
 */
export const USER_ROLES = ['super_admin', 'internal', 'customer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** 项目成员角色（spec §2.1 客户侧），按项目分配 */
export const PROJECT_ROLES = ['project_manager', 'key_user', 'regular_user'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const DEFAULT_ACCESS_TOKEN_TTL = '15m';
export const DEFAULT_REFRESH_TOKEN_TTL = '30d';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const APP_NAME = 'Monitor ERP AI Platform';
