import { z } from 'zod';

/**
 * 操作手册自动生成（issue #26，spec §6）：内部用户选蓝图版本 + 客户数据 → LLM 分章节
 * 生成 → 逐章审校/重生成 → 组装成册 → 落项目知识库草稿（category=manual）→ 发布进客户
 * Index。维护 = manual:generate（仅内部/超管，spec §2.4 手册维护仅内部）；查看 = 项目成员。
 */

/** 章节状态：pending（大纲已定未生成正文）/ ready（AI 生成）/ edited（人工审校） */
export const ManualChapterStatusSchema = z.enum(['pending', 'ready', 'edited']);
export type ManualChapterStatus = z.output<typeof ManualChapterStatusSchema>;

/** 生成会话状态：in_progress（生成/审校中）/ published（已落 kb 草稿） */
export const ManualGenerationStatusSchema = z.enum(['in_progress', 'published']);
export type ManualGenerationStatus = z.output<typeof ManualGenerationStatusSchema>;

/** 章节（正文 ≤ 200KB，同 kb markdown 上限） */
export const ManualChapterSchema = z.object({
  id: z.uuid(),
  seq: z.number().int().positive(), // 1-based 固定顺序（不可重排）
  title: z.string().trim().min(1).max(255),
  outline: z.string().nullable(), // 章节大纲（AI 规划）
  contentMd: z.string().max(200_000).nullable(), // 正文（生成/审校后更新）
  status: ManualChapterStatusSchema,
  aiGeneratedAt: z.iso.datetime().nullable(),
  editedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
export type ManualChapter = z.output<typeof ManualChapterSchema>;

/**
 * 生成会话（列表/详情统一形状）。stale/currentBlueprintVersion 读时计算（AC4）：
 * 蓝图已发布更新版本 → stale=true，建议重新生成（新会话新草稿，不覆盖已审校内容）。
 */
export const ManualGenerationSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  blueprintId: z.uuid(),
  blueprintVersion: z.number().int().positive(), // 生成时的蓝图版本
  title: z.string().trim().min(1).max(255),
  status: ManualGenerationStatusSchema,
  stale: z.boolean(),
  currentBlueprintVersion: z.number().int().positive().nullable(),
  kbDocumentId: z.uuid().nullable(), // 已发布落库的 kb 文档（草稿态）
  chapterCount: z.number().int().nonnegative(),
  readyCount: z.number().int().nonnegative(), // ready/edited 章节数（进度）
  createdBy: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ManualGeneration = z.output<typeof ManualGenerationSchema>;

/** 创建生成会话：选蓝图版本（标题可选，默认「{项目名} 操作手册 v{版本}」） */
export const ManualCreateRequestSchema = z.object({
  blueprintVersion: z.number().int().positive(),
  title: z.string().trim().min(1, { error: '标题不能为空' }).max(255).optional(),
});
export type ManualCreateRequest = z.output<typeof ManualCreateRequestSchema>;

/** 章节审校更新（title/outline/contentMd 至少给一个；保存后 status → edited） */
export const ManualChapterUpdateRequestSchema = z
  .object({
    title: z.string().trim().min(1, { error: '标题不能为空' }).max(255).optional(),
    outline: z.string().max(10_000).optional(),
    contentMd: z.string().max(200_000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { error: '没有可更新的字段' });
export type ManualChapterUpdateRequest = z.output<typeof ManualChapterUpdateRequestSchema>;

/** 列表 */
export const ManualGenerationsListResponseSchema = z.object({
  generations: z.array(ManualGenerationSchema),
});
export type ManualGenerationsListResponse = z.output<typeof ManualGenerationsListResponseSchema>;

/** 详情 = 会话 + 章节列表（生成进度/审校/组装页一步到位） */
export const ManualGenerationDetailSchema = ManualGenerationSchema.extend({
  chapters: z.array(ManualChapterSchema),
});
export type ManualGenerationDetail = z.output<typeof ManualGenerationDetailSchema>;
export const ManualGenerationDetailResponseSchema = z.object({
  generation: ManualGenerationDetailSchema,
});
export type ManualGenerationDetailResponse = z.output<typeof ManualGenerationDetailResponseSchema>;

/** 章节动作统一响应（生成/审校更新） */
export const ManualChapterResponseSchema = z.object({ chapter: ManualChapterSchema });
export type ManualChapterResponse = z.output<typeof ManualChapterResponseSchema>;

/** 组装预览（整本 Markdown；发布走 kb 端点，body ≤ 200KB 由 kb 契约把关） */
export const ManualAssembleResponseSchema = z.object({ body: z.string().max(500_000) });
export type ManualAssembleResponse = z.output<typeof ManualAssembleResponseSchema>;
