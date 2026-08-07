import { z } from 'zod';
import {
  IMPORT_ACTIONS,
  IMPORT_CHANNELS,
  IMPORT_STAGED_STATUSES,
  KB_CATEGORIES,
  KB_DOC_TYPES,
} from '@monitor/shared';

/**
 * Online help 导入通道（spec §4.4，issue #25）：导入 API（外部项目推送）+ 定时拉取
 * （平台定时 HTTP 拉取外部文档清单）双通道 → import_staged_documents 暂存队列 →
 * 消费 worker 增量落库（新文档入 / 变更更新 / 删除移除，指纹去重）→ 只读文档
 * （source='online_help' 不可在线编辑，人工发布后复用 #21 管线进内部 Index）。
 */

/** 暂存状态 / 动作 / 通道（镜像 DB check 与 shared 常量） */
export const ImportStagedStatusSchema = z.enum(IMPORT_STAGED_STATUSES);
export type ImportStagedStatus = z.output<typeof ImportStagedStatusSchema>;

export const ImportStagedActionSchema = z.enum(IMPORT_ACTIONS);
export type ImportStagedAction = z.output<typeof ImportStagedActionSchema>;

export const ImportChannelSchema = z.enum(IMPORT_CHANNELS);
export type ImportChannel = z.output<typeof ImportChannelSchema>;

/** 推送请求（action 判别：upsert = 新文档/变更；delete = 移除，只需 sourceKey） */
const ImportMarkdownPushSchema = z.object({
  action: z.literal('upsert'),
  sourceKey: z.string().trim().min(1, { error: 'sourceKey 不能为空' }).max(255),
  docType: z.literal('markdown'),
  title: z.string().trim().min(1, { error: '标题不能为空' }).max(255),
  category: z.enum(KB_CATEGORIES, { error: '分类必须是 manual/faq/best_practice' }),
  body: z.string().max(200_000), // Markdown 正文（HTML 同通道，渲染 escape-first）
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const ImportFilePushSchema = z.object({
  action: z.literal('upsert'),
  sourceKey: z.string().trim().min(1, { error: 'sourceKey 不能为空' }).max(255),
  docType: z.literal('file'),
  title: z.string().trim().min(1, { error: '标题不能为空' }).max(255),
  category: z.enum(KB_CATEGORIES, { error: '分类必须是 manual/faq/best_practice' }),
  fileName: z.string().trim().min(1, { error: '文件名不能为空' }).max(255),
  contentType: z.string().trim().min(1, { error: '文件类型不能为空' }).max(128),
  base64: z.string().min(1, { error: '文件内容不能为空' }).max(8_000_000, {
    error: '文件过大（解码后 ≤ 6MB）',
  }),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const ImportDeletePushSchema = z.object({
  action: z.literal('delete'),
  sourceKey: z.string().trim().min(1, { error: 'sourceKey 不能为空' }).max(255),
});
// zod v4 discriminatedUnion 不允许两个分支共用判别值——upsert 分支按 docType
// 子判别（sub-discriminator）嵌套，外层再按 action 判别（delete/upsert）
const ImportUpsertPushSchema = z.discriminatedUnion('docType', [
  ImportMarkdownPushSchema,
  ImportFilePushSchema,
]);
export const ImportPushRequestSchema = z.discriminatedUnion('action', [
  ImportUpsertPushSchema,
  ImportDeletePushSchema,
]);
export type ImportPushRequest = z.output<typeof ImportPushRequestSchema>;

/** 暂存记录（调试页/响应统一形状；documentId 非空 = 已 apply 到知识库） */
export const ImportStagedSchema = z.object({
  id: z.uuid(),
  source: ImportChannelSchema,
  sourceKey: z.string(),
  action: ImportStagedActionSchema,
  fingerprint: z.string(),
  title: z.string().trim().min(1).max(255),
  category: z.enum(KB_CATEGORIES),
  docType: z.enum(KB_DOC_TYPES),
  fileName: z.string().nullable().optional(),
  contentType: z.string().nullable().optional(),
  documentId: z.uuid().nullable().optional(), // apply 后关联的 kb 文档
  status: ImportStagedStatusSchema,
  attempt: z.number().int().nonnegative(),
  lastError: z.string().nullable().optional(),
  duplicateCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ImportStaged = z.output<typeof ImportStagedSchema>;

/** 推送响应：暂存记录 + 是否判重（duplicated=true = 同指纹跳过，未重新入队） */
export const ImportPushResponseSchema = z.object({
  record: ImportStagedSchema,
  duplicated: z.boolean(),
});
export type ImportPushResponse = z.output<typeof ImportPushResponseSchema>;

/** 暂存列表（调试页） */
export const ImportStagedListResponseSchema = z.object({
  records: z.array(ImportStagedSchema),
});
export type ImportStagedListResponse = z.output<typeof ImportStagedListResponseSchema>;

/** 暂存列表筛选（status / 通道） */
export const ImportStagedQuerySchema = z.object({
  status: ImportStagedStatusSchema.optional(),
  source: ImportChannelSchema.optional(),
});
export type ImportStagedQuery = z.output<typeof ImportStagedQuerySchema>;

/** 手动触发一次拉取的汇总（fetched = 清单条数；staged = 新入队/重置条数；deleted = 派生删除条数） */
export const ImportFetchRunResponseSchema = z.object({
  fetched: z.number().int().nonnegative(),
  staged: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
});
export type ImportFetchRunResponse = z.output<typeof ImportFetchRunResponseSchema>;
