import { z } from 'zod';

export const EnvSchema = z.object({
  DATABASE_URL: z.url(),
  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  PORT: z.coerce.number().int().positive().default(3001),
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
