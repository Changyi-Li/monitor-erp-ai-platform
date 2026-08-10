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

/** 问题关联目标类型（issue_links.targetType，spec 42「关联蓝图/功能/文档」；功能无独立实体，见 ADR 0009） */
export const ISSUE_LINK_TARGETS = ['blueprint', 'minute', 'kb_document'] as const;
export type IssueLinkTargetType = (typeof ISSUE_LINK_TARGETS)[number];

/** RAG 同步任务状态（document_syncs.status，#21 发布即同步管线） */
export const RAG_SYNC_STATUSES = ['queued', 'processing', 'succeeded', 'failed'] as const;
export type RagSyncStatus = (typeof RAG_SYNC_STATUSES)[number];

/** RAG 同步 scope（spec 57：内部文档→内部 Index，项目文档→客户 Index） */
export const RAG_SCOPES = ['internal', 'customer'] as const;
export type RagScope = (typeof RAG_SCOPES)[number];

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

/** 知识库文档分类（spec §4.1：操作手册/FAQ/最佳实践） */
export const KB_CATEGORIES = ['manual', 'faq', 'best_practice'] as const;
export type KbCategory = (typeof KB_CATEGORIES)[number];

/** 知识库文档形态（spec §4.1：在线 Markdown 或上传文件） */
export const KB_DOC_TYPES = ['markdown', 'file'] as const;
export type KbDocType = (typeof KB_DOC_TYPES)[number];

/** 知识库文档生命周期（草稿 → 已发布 → 已归档；归档即下架，可恢复） */
export const KB_STATUSES = ['draft', 'published', 'archived'] as const;
export type KbStatus = (typeof KB_STATUSES)[number];

/** 知识库文档来源（issue #25：内部创作 / 外部导入；online_help 只读，externalKey 非空） */
export const KB_SOURCES = ['manual', 'online_help'] as const;
export type KbSource = (typeof KB_SOURCES)[number];

/** 导入通道（issue #25：外部项目推送 / 平台定时拉取；externalKey = `${channel}:${sourceKey}` 键空间隔离） */
export const IMPORT_CHANNELS = ['api', 'fetch'] as const;
export type ImportChannel = (typeof IMPORT_CHANNELS)[number];

/** 导入动作（upsert = 新文档/变更；delete = 移除） */
export const IMPORT_ACTIONS = ['upsert', 'delete'] as const;
export type ImportAction = (typeof IMPORT_ACTIONS)[number];

/** 导入暂存状态（import_staged_documents.status；消费后 processed，失败退避重试） */
export const IMPORT_STAGED_STATUSES = ['pending', 'processing', 'processed', 'failed'] as const;
export type ImportStagedStatus = (typeof IMPORT_STAGED_STATUSES)[number];

/** LLM 场景（spec #80 场景化多模型路由，issue #24；4 场景定稿，DB check 同步） */
export const LLM_SCENES = ['agent', 'document_parsing', 'manual_generation', 'embedding'] as const;
export type LlmScene = (typeof LLM_SCENES)[number];

/** 场景中文标签（契约 ai/config 与 web 配置页共用） */
export const LLM_SCENE_LABELS: Record<LlmScene, string> = {
  agent: '客服问答',
  document_parsing: '文档解析',
  manual_generation: '操作手册生成',
  embedding: '向量化（Embedding）',
};

export const DEFAULT_ACCESS_TOKEN_TTL = '15m';
export const DEFAULT_REFRESH_TOKEN_TTL = '30d';

export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 128;

export const APP_NAME = 'Monitor ERP AI Platform';
