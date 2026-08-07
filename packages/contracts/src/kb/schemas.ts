import { z } from 'zod';
import {
  KB_CATEGORIES,
  KB_DOC_TYPES,
  KB_SOURCES,
  KB_STATUSES,
} from '@monitor/shared';

/**
 * 内部知识库（spec §4.1/§4.3，issue #19）：全局文档（不挂客户/项目——客户知识库
 * = 内部 KB + 本项目文档是逻辑视图）。分类（操作手册/FAQ/最佳实践）+ 形态
 * （在线 Markdown / 上传文件）+ 生命周期（草稿 → 已发布 → 已归档，可恢复）+
 * 版本化（编辑已发布 → 派生新草稿版本，重新发布才生效）。维护 = 内部
 * （kb:edit，spec §2.4「知识库文档编辑 ✅ 仅内部」）；查看默认开放（无 kb:view）：
 * 客户用户只读已发布文档（为 #27 客户知识库铺路）。
 */

/** 知识库 viewerRole（全局域无项目成员概念；内部 vs 客户用户） */
export const KbViewerRoleSchema = z.enum(['internal', 'customer']);
export type KbViewerRole = z.output<typeof KbViewerRoleSchema>;

/** 文件类文档元信息（文件本体在对象存储，经 StoragePort 存取） */
export const KbFileSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(128),
  size: z.number().int().nonnegative(),
});
export type KbFile = z.output<typeof KbFileSchema>;

/** 知识库文档（列表/详情统一形状；hasDraft = 已发布 + 有待发布草稿修改；source = 内部创作/外部导入只读） */
export const KbDocumentSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1).max(255),
  category: z.enum(KB_CATEGORIES),
  docType: z.enum(KB_DOC_TYPES),
  status: z.enum(KB_STATUSES),
  source: z.enum(KB_SOURCES),
  hasDraft: z.boolean(),
  createdBy: z.object({ id: z.uuid(), displayName: z.string() }).nullable(), // 创建人（join users）
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type KbDocument = z.output<typeof KbDocumentSchema>;

/** 文档详情 = 头 + 当前可见内容（markdown 内联 body / 文件元信息）+ viewerRole */
export const KbDocumentDetailSchema = KbDocumentSchema.extend({
  body: z.string().max(200_000).optional(), // markdown 当前可见内容（草稿文档→草稿；已发布→线上）
  file: KbFileSchema.optional(), // 文件类当前线上元信息
  viewerRole: KbViewerRoleSchema,
});
export type KbDocumentDetail = z.output<typeof KbDocumentDetailSchema>;

/** 创建文档（草稿）：markdown 或文件（JSON + base64，同 drawio/minutes——不引入 multipart） */
const KbMarkdownCreateSchema = z.object({
  docType: z.literal('markdown'),
  title: z.string().trim().min(1, { error: '标题不能为空' }).max(255),
  category: z.enum(KB_CATEGORIES, { error: '分类必须是 manual/faq/best_practice' }),
  body: z.string().max(200_000).optional(), // Markdown 正文（可先建框架后补内容）
});
const KbFileCreateSchema = z.object({
  docType: z.literal('file'),
  title: z.string().trim().min(1, { error: '标题不能为空' }).max(255),
  category: z.enum(KB_CATEGORIES, { error: '分类必须是 manual/faq/best_practice' }),
  fileName: z.string().trim().min(1, { error: '文件名不能为空' }).max(255),
  contentType: z.string().trim().min(1, { error: '文件类型不能为空' }).max(128),
  base64: z.string().min(1, { error: '文件内容不能为空' }).max(8_000_000, {
    error: '文件过大（解码后 ≤ 6MB）',
  }),
});
export const KbCreateRequestSchema = z.discriminatedUnion('docType', [
  KbMarkdownCreateSchema,
  KbFileCreateSchema,
]);
export type KbCreateRequest = z.output<typeof KbCreateRequestSchema>;

/**
 * 保存草稿（部分更新）：markdown 类支持 title/category/body；文件类 = 覆盖上传
 * （fileName/contentType/base64 一起给）。service 按 docType 取舍——markdown 类忽略
 * 文件字段、文件类忽略 body（简单化，注释在此；两形态互斥由文档 docType 决定）。
 */
export const KbUpdateRequestSchema = z
  .object({
    title: z.string().trim().min(1, { error: '标题不能为空' }).max(255).optional(),
    category: z.enum(KB_CATEGORIES, { error: '分类必须是 manual/faq/best_practice' }).optional(),
    body: z.string().max(200_000).optional(), // markdown 类正文
    fileName: z.string().trim().min(1, { error: '文件名不能为空' }).max(255).optional(),
    contentType: z.string().trim().min(1, { error: '文件类型不能为空' }).max(128).optional(),
    base64: z.string().min(1, { error: '文件内容不能为空' }).max(8_000_000, {
      error: '文件过大（解码后 ≤ 6MB）',
    }).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { error: '没有可更新的字段' });
export type KbUpdateRequest = z.output<typeof KbUpdateRequestSchema>;

/** 发布版本（版本历史项；versionNumber 为 null = 未发布草稿版本） */
export const KbVersionSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  versionNumber: z.number().int().positive().nullable(), // 发布版本 1-based；草稿版本 null
  title: z.string().trim().min(1).max(255),
  category: z.enum(KB_CATEGORIES),
  body: z.string().max(200_000).optional(), // markdown 快照
  file: KbFileSchema.optional(), // 文件快照
  publishedBy: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  publishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type KbVersion = z.output<typeof KbVersionSchema>;

export const KbListResponseSchema = z.object({
  documents: z.array(KbDocumentSchema),
  viewerRole: KbViewerRoleSchema,
});
export type KbListResponse = z.output<typeof KbListResponseSchema>;

/** 创建/保存/发布/归档/恢复统一响应（detail 含当前可见内容，前端一步到位） */
export const KbDocumentResponseSchema = z.object({ document: KbDocumentDetailSchema });
export type KbDocumentResponse = z.output<typeof KbDocumentResponseSchema>;

/** 版本历史（内部端点） */
export const KbVersionsResponseSchema = z.object({ versions: z.array(KbVersionSchema) });
export type KbVersionsResponse = z.output<typeof KbVersionsResponseSchema>;

/** markdown 内容端点（版本回看） */
export const KbContentResponseSchema = z.object({ body: z.string().max(200_000) });
export type KbContentResponse = z.output<typeof KbContentResponseSchema>;
