/**
 * 平台粗粒度角色（JWT 级，TenantInterceptor 以 role !== 'customer' 判定内部旁路）。
 * 客户用户的细粒度角色（PM/Key User/普通用户）按项目存 project_members，不进 JWT。
 */
export const USER_ROLES = ['super_admin', 'internal', 'customer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** 项目成员角色（spec §2.1 客户侧），按项目分配 */
export const PROJECT_ROLES = ['project_manager', 'key_user', 'regular_user'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** 问题类型（issue.type，spec §3.5） */
export const ISSUE_TYPES = ['bug', 'feature', 'question'] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

/** 问题分类（issue.category：功能/数据/使用/技术/优化） */
export const ISSUE_CATEGORIES = ['function', 'data', 'usage', 'technical', 'optimization'] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

/** 问题优先级 */
export const ISSUE_PRIORITIES = ['high', 'medium', 'low'] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

/** 问题状态机（严格线性前进：新建→处理中→已解决→已关闭） */
export const ISSUE_STATUSES = ['new', 'in_progress', 'resolved', 'closed'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const DEFAULT_ACCESS_TOKEN_TTL = '15m';
export const DEFAULT_REFRESH_TOKEN_TTL = '30d';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const APP_NAME = 'Monitor ERP AI Platform';
