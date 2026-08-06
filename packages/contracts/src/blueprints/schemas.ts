import { z } from 'zod';
import { ProjectViewerRoleSchema } from '../projects/schemas';

/**
 * 蓝图（spec §3.2，issue #16）：一个项目一份，带版本控制。
 * 版本内容 = draw.io 流程图（对象存储，base64 上传）+ 结构化文档
 * （业务需求/模块功能范围/配置说明/流程描述）；版本为两者的一致性快照。
 * 内部（实施）维护；客户用户只读（spec §2.4 蓝图维护仅内部）。
 */

/** draw.io 文件元数据（文件本体存对象存储，DB 只存 key + 元信息） */
export const BlueprintDrawioSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(128),
  size: z.number().int().nonnegative(),
});
export type BlueprintDrawio = z.output<typeof BlueprintDrawioSchema>;

/** 当前蓝图（可编辑的工作内容；发布时快照到 blueprint_versions） */
export const BlueprintSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  businessRequirements: z.string().max(20000).nullable(),
  moduleScope: z.string().max(20000).nullable(),
  configNotes: z.string().max(20000).nullable(),
  processDescription: z.string().max(20000).nullable(),
  drawio: BlueprintDrawioSchema.nullable(), // 当前文件；未上传前为 null
  latestVersion: z.number().int().positive().nullable(), // 已发布版本数（null = 未发布）
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Blueprint = z.output<typeof BlueprintSchema>;

/** 版本快照（发布时冻结：字段 + 文件 key 一致快照，不可变） */
export const BlueprintVersionSchema = z.object({
  id: z.uuid(),
  blueprintId: z.uuid(),
  version: z.number().int().positive(),
  businessRequirements: z.string().max(20000).nullable(),
  moduleScope: z.string().max(20000).nullable(),
  configNotes: z.string().max(20000).nullable(),
  processDescription: z.string().max(20000).nullable(),
  drawio: BlueprintDrawioSchema.nullable(),
  publishedBy: z.object({ id: z.uuid(), displayName: z.string() }).nullable(), // 发布人（join users）
  publishedAt: z.iso.datetime(),
});
export type BlueprintVersion = z.output<typeof BlueprintVersionSchema>;

/** 上传的 draw.io 文件（base64 编码；draw.io 本质 XML 文本，base64 保字节一致） */
export const DrawioUploadSchema = z.object({
  name: z.string().trim().min(1, { error: '文件名不能为空' }).max(255),
  contentType: z.string().trim().min(1, { error: '文件类型不能为空' }).max(128),
  base64: z.string().min(1, { error: '文件内容不能为空' }).max(8_000_000, {
    error: 'draw.io 文件过大（解码后 ≤ 6MB）',
  }),
});
export type DrawioUpload = z.output<typeof DrawioUploadSchema>;

/** 创建蓝图（首次：上传 draw.io + 结构化内容 → 自动发布 v1 快照） */
export const BlueprintCreateRequestSchema = z.object({
  businessRequirements: z.string().max(20000).optional(),
  moduleScope: z.string().max(20000).optional(),
  configNotes: z.string().max(20000).optional(),
  processDescription: z.string().max(20000).optional(),
  drawio: DrawioUploadSchema, // 首版必带文件
});
export type BlueprintCreateRequest = z.output<typeof BlueprintCreateRequestSchema>;

/** 编辑当前内容（部分更新；drawio 可选——不带则保留现有文件） */
export const BlueprintUpdateRequestSchema = z.object({
  businessRequirements: z.string().max(20000).optional(),
  moduleScope: z.string().max(20000).optional(),
  configNotes: z.string().max(20000).optional(),
  processDescription: z.string().max(20000).optional(),
  drawio: DrawioUploadSchema.optional(),
});
export type BlueprintUpdateRequest = z.output<typeof BlueprintUpdateRequestSchema>;

export const BlueprintGetResponseSchema = z.object({
  blueprint: BlueprintSchema.nullable(), // null = 项目尚未创建蓝图
  viewerRole: ProjectViewerRoleSchema,
});
export type BlueprintGetResponse = z.output<typeof BlueprintGetResponseSchema>;

/** 创建/发布（发布即生成新版本快照，version = 最新版本详情） */
export const BlueprintPublishResponseSchema = z.object({
  blueprint: BlueprintSchema,
  version: BlueprintVersionSchema,
});
export type BlueprintPublishResponse = z.output<typeof BlueprintPublishResponseSchema>;

export const BlueprintUpdateResponseSchema = z.object({ blueprint: BlueprintSchema });
export type BlueprintUpdateResponse = z.output<typeof BlueprintUpdateResponseSchema>;

export const BlueprintVersionsListResponseSchema = z.object({
  versions: z.array(BlueprintVersionSchema),
});
export type BlueprintVersionsListResponse = z.output<typeof BlueprintVersionsListResponseSchema>;

export const BlueprintVersionGetResponseSchema = z.object({
  version: BlueprintVersionSchema,
});
export type BlueprintVersionGetResponse = z.output<typeof BlueprintVersionGetResponseSchema>;
