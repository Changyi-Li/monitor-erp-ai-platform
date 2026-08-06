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

/** 实施阶段状态（spec §3.3：未开始/进行中/已完成/已暂停；应用层自由流转） */
export const STAGE_STATUSES = ['not_started', 'in_progress', 'completed', 'paused'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/** 标准阶段模板（spec §3.3「基于标准阶段模板」；Phase 1 为内置常量，模板维护留待后续） */
export const STAGE_TEMPLATES = [
  { key: 'requirements', name: '需求分析', description: '调研客户业务流程与需求，确认实施范围' },
  { key: 'blueprint', name: '蓝图设计', description: '绘制实施蓝图（draw.io 流程图 + 结构化文档）' },
  { key: 'configuration', name: '系统配置', description: '按蓝图进行系统配置与基础数据准备' },
  { key: 'testing', name: '测试验收', description: '功能测试、数据核对与客户验收' },
  { key: 'go_live', name: '上线支持', description: '正式上线切换与上线后支持' },
] as const;
export type StageTemplateKey = (typeof STAGE_TEMPLATES)[number]['key'];

/** 风险等级（spec §3.3：高/中/低） */
export const RISK_LEVELS = ['high', 'medium', 'low'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** 风险状态（未处理/处理中/已解决） */
export const RISK_STATUSES = ['open', 'in_progress', 'resolved'] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export const DEFAULT_ACCESS_TOKEN_TTL = '15m';
export const DEFAULT_REFRESH_TOKEN_TTL = '30d';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const APP_NAME = 'Monitor ERP AI Platform';
