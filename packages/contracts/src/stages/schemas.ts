import { RISK_LEVELS, RISK_STATUSES, STAGE_STATUSES, STAGE_TEMPLATES } from '@monitor/shared';
import { z } from 'zod';
import { AssigneesListResponseSchema } from '../issues/schemas';
import { ProjectViewerRoleSchema } from '../projects/schemas';

/** 模板 key 枚举（STAGE_TEMPLATES 派生，z.enum 需要元组形态） */
const STAGE_TEMPLATE_KEYS = STAGE_TEMPLATES.map((t) => t.key) as [string, ...string[]];

/**
 * 实施阶段（spec §3.3）：基于标准阶段模板在项目内实例化，可增删/排序/状态流转。
 * 状态 = 未开始/进行中/已完成/已暂停（自由流转，无严格状态机——与 issues 不同）。
 * 归属项目 = 数据隔离边界；tenantId 冗余存储供 RLS（同 projects/issues 模式）。
 */
export const StageSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  templateKey: z.enum(STAGE_TEMPLATE_KEYS).nullable(), // 来源模板（自定义阶段为 null）
  name: z.string().trim().min(1).max(128),
  description: z.string().nullable().optional(),
  status: z.enum(STAGE_STATUSES),
  sortOrder: z.number().int().nonnegative(), // 项目内排序（重排时重写）
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Stage = z.output<typeof StageSchema>;

/** 风险点（spec §3.3）：项目级，可关联具体阶段；等级 高/中/低；状态 未处理/处理中/已解决 */
export const RiskSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  stageId: z.uuid().nullable().optional(),
  stageName: z.string().nullable().optional(), // join project_stages（看板展示）
  description: z.string().trim().min(1).max(2000),
  level: z.enum(RISK_LEVELS),
  status: z.enum(RISK_STATUSES),
  ownerId: z.uuid().nullable().optional(),
  ownerName: z.string().nullable().optional(), // join users（负责人展示）
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Risk = z.output<typeof RiskSchema>;

/** 标准阶段模板（Phase 1 内置常量，只读列表） */
export const StageTemplateSchema = z.object({
  key: z.enum(STAGE_TEMPLATE_KEYS),
  name: z.string(),
  description: z.string(),
});
export type StageTemplate = z.output<typeof StageTemplateSchema>;

/** 创建阶段（模板选中填充名称可改；templateKey 记录来源，name 必填） */
export const StageCreateRequestSchema = z.object({
  templateKey: z.enum(STAGE_TEMPLATE_KEYS, { error: '阶段模板非法' }).optional(),
  name: z.string().trim().min(1, { error: '阶段名称不能为空' }).max(128),
  description: z.string().max(2000).optional(),
});
export type StageCreateRequest = z.output<typeof StageCreateRequestSchema>;

/** 编辑阶段（部分更新：undefined 不动、null 清空 description；status 直接流转，无严格状态机） */
export const StageUpdateRequestSchema = z.object({
  name: z.string().trim().min(1, { error: '阶段名称不能为空' }).max(128).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(STAGE_STATUSES, { error: '阶段状态非法' }).optional(),
});
export type StageUpdateRequest = z.output<typeof StageUpdateRequestSchema>;

/** 排序调整（全量目标顺序，服务层按索引重写 sortOrder） */
export const StageReorderRequestSchema = z.object({
  stageIds: z.array(z.uuid(), { error: '阶段列表非法' }).min(1),
});
export type StageReorderRequest = z.output<typeof StageReorderRequestSchema>;

/** 创建风险（等级必填；状态默认未处理；可关联阶段 + 负责人） */
export const RiskCreateRequestSchema = z.object({
  description: z.string().trim().min(1, { error: '风险描述不能为空' }).max(2000),
  level: z.enum(RISK_LEVELS, { error: '风险等级必须是 高/中/低' }),
  status: z.enum(RISK_STATUSES, { error: '风险状态非法' }).optional(),
  stageId: z.uuid().nullable().optional(),
  ownerId: z.uuid().nullable().optional(),
});
export type RiskCreateRequest = z.output<typeof RiskCreateRequestSchema>;

/** 更新风险（部分更新；null 清空 stageId/ownerId；空对象=无操作） */
export const RiskUpdateRequestSchema = z.object({
  description: z.string().trim().min(1, { error: '风险描述不能为空' }).max(2000).optional(),
  level: z.enum(RISK_LEVELS).optional(),
  status: z.enum(RISK_STATUSES).optional(),
  stageId: z.uuid().nullable().optional(),
  ownerId: z.uuid().nullable().optional(),
});
export type RiskUpdateRequest = z.output<typeof RiskUpdateRequestSchema>;

export const StageTemplatesResponseSchema = z.object({ templates: z.array(StageTemplateSchema) });
export type StageTemplatesResponse = z.output<typeof StageTemplatesResponseSchema>;

export const StagesListResponseSchema = z.object({
  stages: z.array(StageSchema),
  viewerRole: ProjectViewerRoleSchema,
});
export type StagesListResponse = z.output<typeof StagesListResponseSchema>;

export const StageResponseSchema = z.object({ stage: StageSchema });
export type StageResponse = z.output<typeof StageResponseSchema>;

export const RisksListResponseSchema = z.object({
  risks: z.array(RiskSchema),
  viewerRole: ProjectViewerRoleSchema,
});
export type RisksListResponse = z.output<typeof RisksListResponseSchema>;

export const RiskResponseSchema = z.object({ risk: RiskSchema });
export type RiskResponse = z.output<typeof RiskResponseSchema>;

/** 风险负责人候选（内部/超管 active 用户；复用 issues 指派候选形状） */
export const RiskOwnersListResponseSchema = AssigneesListResponseSchema;
export type RiskOwnersListResponse = z.output<typeof RiskOwnersListResponseSchema>;
