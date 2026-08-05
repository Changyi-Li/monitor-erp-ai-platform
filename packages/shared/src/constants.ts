/** 平台角色（RBAC 演进后扩充） */
export const USER_ROLES = ['internal', 'customer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const DEFAULT_ACCESS_TOKEN_TTL = '15m';
export const DEFAULT_REFRESH_TOKEN_TTL = '30d';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const APP_NAME = 'Monitor ERP AI Platform';
