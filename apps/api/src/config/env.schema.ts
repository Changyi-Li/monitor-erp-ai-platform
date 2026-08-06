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
  // LLM 门面（切片 13/14 扩 openai-compatible 时只扩 enum + 加 case）
  LLM_DRIVER: z.enum(['memory']).default('memory'),
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
