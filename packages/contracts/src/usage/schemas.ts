import { z } from 'zod';

/**
 * AI Token 用量计量（issue #23，spec #77–#79）：
 * LLMClient 统一记录每次调用用量（场景/模型/输入输出 token/归属）落库 ai_usage；
 * 内部用户按客户/项目/时间/场景/模型查看统计汇总与趋势（客户用户 403）。
 * costUsd 为 per-call 成本预留（真实驱动填；Phase 2 客户 AI 成本视图 =
 * sum(costUsd) + RAG Index 规格费 21.6 元/月/客户）。
 */

/** spec 定稿 4 场景（本期仅 agent 产生数据，其余随切片 13/14、15 填充） */
export const USAGE_SCENES = ['agent', 'document_parsing', 'manual_generation', 'embedding'] as const;
export const UsageSceneSchema = z.enum(USAGE_SCENES);
export type UsageScene = z.output<typeof UsageSceneSchema>;

/** summary 查询（全部 optional；非法枚举/非法日期 → 400） */
export const UsageSummaryQuerySchema = z.object({
  customerId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  scene: UsageSceneSchema.optional(),
  model: z.string().trim().max(64).optional(),
  /** ISO 8601（含时区，如 2026-08-01T00:00:00.000Z）；不传 = 不限 */
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
export type UsageSummaryQuery = z.output<typeof UsageSummaryQuerySchema>;

/** trend 查询：时间序列聚合（granularity 默认 day） */
export const UsageTrendQuerySchema = UsageSummaryQuerySchema.extend({
  granularity: z.enum(['day', 'month']).default('day'),
});
export type UsageTrendQuery = z.output<typeof UsageTrendQuerySchema>;

/** 分组汇总条目（客户/项目/场景/模型各维一组；key null = 「未归属」组） */
export const UsageGroupEntrySchema = z.object({
  /** 维度键（customerId/projectId/scene/model；null = 未归属） */
  key: z.string().nullable(),
  /** 展示名（客户名/项目名/场景/模型；未归属 → 「未归属」） */
  name: z.string(),
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** 成本汇总（预留；memory fake 阶段无真实单价 → null） */
  costUsd: z.number().nullable(),
});
export type UsageGroupEntry = z.output<typeof UsageGroupEntrySchema>;

export const UsageTotalsSchema = z.object({
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalCostUsd: z.number().nullable(),
});
export type UsageTotals = z.output<typeof UsageTotalsSchema>;

export const UsageSummaryResponseSchema = z.object({
  total: UsageTotalsSchema,
  byCustomer: z.array(UsageGroupEntrySchema),
  byProject: z.array(UsageGroupEntrySchema),
  byScene: z.array(UsageGroupEntrySchema),
  byModel: z.array(UsageGroupEntrySchema),
});
export type UsageSummaryResponse = z.output<typeof UsageSummaryResponseSchema>;

/** 趋势点（date_trunc 桶；day → 当日 00:00 UTC，month → 当月 1 日 00:00 UTC） */
export const UsageTrendPointSchema = z.object({
  bucket: z.iso.datetime(),
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type UsageTrendPoint = z.output<typeof UsageTrendPointSchema>;

export const UsageTrendResponseSchema = z.object({ points: z.array(UsageTrendPointSchema) });
export type UsageTrendResponse = z.output<typeof UsageTrendResponseSchema>;
