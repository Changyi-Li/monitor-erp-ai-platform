import { z } from 'zod';

export const EnvSchema = z.object({
  // 应用连接：受限角色（非 owner、无 BYPASSRLS），RLS 兜底生效
  DATABASE_URL: z.url(),
  // 仅迁移/管理/测试 seed 用（owner 凭据）；生产不配置
  DATABASE_OWNER_URL: z.url().optional(),
  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  PORT: z.coerce.number().int().positive().default(3001),
  // 邀请链接前缀（web 前端地址；无邮件基础设施时由 API 直接返回完整链接）
  WEB_URL: z.url().default('http://localhost:3000'),
  // 适配层驱动：切换实现只改配置，业务代码零改动
  STORAGE_DRIVER: z.enum(['memory']).default('memory'),
  MQ_DRIVER: z.enum(['memory']).default('memory'),
  INDEX_DRIVER: z.enum(['memory']).default('memory'),
  // LLM 门面（issue #24 场景化多模型路由）：场景专属驱动优先，缺省回退 LLM_DRIVER
  LLM_DRIVER: z.enum(['memory', 'openai']).default('memory'),
  LLM_DRIVER_AGENT: z.enum(['memory', 'openai']).optional(),
  LLM_DRIVER_DOCUMENT_PARSING: z.enum(['memory', 'openai']).optional(),
  LLM_DRIVER_MANUAL_GENERATION: z.enum(['memory', 'openai']).optional(),
  LLM_DRIVER_EMBEDDING: z.enum(['memory', 'openai']).optional(),
  // openai-compatible 驱动（DashScope/DeepSeek/GLM；缺省值见 ADR 0013）
  LLM_OPENAI_BASE_URL: z.url().optional(),
  LLM_OPENAI_API_KEY: z.string().min(1).optional(),
  LLM_OPENAI_MODEL: z.string().min(1).optional(),
  // Online help 导入（issue #25）：IMPORT_API_KEY 未配置 → API 通道禁用（仅 JWT 调试页）；
  // IMPORT_FETCH_URL 未配置 → 定时拉取 worker 不启动（功能自然关闭）
  IMPORT_API_KEY: z.string().min(16).optional(),
  IMPORT_FETCH_URL: z.url().optional(),
  IMPORT_FETCH_API_KEY: z.string().min(1).optional(),
  IMPORT_FETCH_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
}).superRefine((env, ctx) => {
  // 任一场景解析为 openai 驱动但缺 API Key → 启动期 fail-fast（llm.module 构造也会抛，双保险）
  const usesOpenai =
    env.LLM_DRIVER === 'openai' ||
    env.LLM_DRIVER_AGENT === 'openai' ||
    env.LLM_DRIVER_DOCUMENT_PARSING === 'openai' ||
    env.LLM_DRIVER_MANUAL_GENERATION === 'openai' ||
    env.LLM_DRIVER_EMBEDDING === 'openai';
  if (usesOpenai && !env.LLM_OPENAI_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      message: '配置了 openai 驱动但缺少 LLM_OPENAI_API_KEY',
      path: ['LLM_OPENAI_API_KEY'],
    });
  }
});
export type Env = z.infer<typeof EnvSchema>;

/** @nestjs/config validate 回调：启动期 fail-fast */
export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = EnvSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`环境变量校验失败: ${issues}`);
  }
  return parsed.data;
}
