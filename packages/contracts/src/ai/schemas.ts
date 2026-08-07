import { z } from 'zod';
import { LLM_SCENES, LLM_SCENE_LABELS } from '@monitor/shared';

/**
 * 多模态与场景化多模型（issue #24，spec #80–#82）：
 * - LLM 场景 → 模型映射配置（LLM_DRIVER_<SCENE> 回退 LLM_DRIVER，换模型只改配置）
 * - 图片解析（draw.io 蓝图截图/文档截图/附件图片 → 结构化结果），scene='document_parsing'
 * 内部专属（agent:use 权限域，客户 403）。
 */

/** LLM 调用用量（与 LlmChatResult.usage 同形状；web 展示计量链路） */
export const LlmUsageSchema = z.object({
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type LlmUsage = z.output<typeof LlmUsageSchema>;

/** 图片解析请求：JSON + base64（同 drawio/minutes/kb 上传通道——不引入 multipart） */
export const AiImageParsingRequestSchema = z.object({
  image: z.object({
    /** base64 内容（≤8M 字符 ≈ 6MB 二进制，同 kb 上传上限） */
    base64: z
      .string()
      .min(1, { error: '图片内容不能为空' })
      .max(8_000_000, { error: '图片过大（解码后不超过 6MB）' }),
    /** MIME 类型（如 image/png；服务端校验 ^image/ 前缀） */
    contentType: z.string().trim().min(1).max(128),
  }),
  /** 附加解析指令（如「提取审批流」） */
  prompt: z.string().max(2_000).optional(),
});
export type AiImageParsingRequest = z.output<typeof AiImageParsingRequestSchema>;

/** 图片解析响应：结构化内容 + 用量（计量链路可见；切换模型后 usage.model 可观测差异） */
export const AiImageParsingResponseSchema = z.object({
  content: z.string().max(100_000),
  usage: LlmUsageSchema,
});
export type AiImageParsingResponse = z.output<typeof AiImageParsingResponseSchema>;

/** 场景 → 驱动/模型映射（web 配置页表格直渲，数组固定 LLM_SCENES 序） */
export const AiSceneConfigSchema = z.object({
  scene: z.enum(LLM_SCENES),
  /** 中文场景名（shared LLM_SCENE_LABELS） */
  label: z.string(),
  /** 驱动名（memory 内置 fake / openai 兼容协议） */
  driver: z.enum(['memory', 'openai']),
  /** 实际生效模型名（memory → 'memory'；openai → 配置模型） */
  model: z.string(),
  /** 配置来源：场景专属 / 全局 LLM_DRIVER / 内置兜底 */
  source: z.enum(['scene', 'global', 'default']),
  /** 是否可用（openai 缺 API Key → false） */
  enabled: z.boolean(),
  /** 不可用原因（缺 key 等） */
  reason: z.string().optional(),
});
export type AiSceneConfig = z.output<typeof AiSceneConfigSchema>;

export const AiConfigResponseSchema = z.object({
  scenes: z.array(AiSceneConfigSchema),
});
export type AiConfigResponse = z.output<typeof AiConfigResponseSchema>;

export { LLM_SCENES, LLM_SCENE_LABELS };
