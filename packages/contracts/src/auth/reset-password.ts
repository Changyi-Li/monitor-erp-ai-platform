import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@monitor/shared';

/**
 * 重置用户密码（#39）：超管重置任意用户 / 任何用户改自己的密码（service 层鉴权）。
 * 新密码立即生效，旧密码即刻失效。
 */
export const ResetUserPasswordRequestSchema = z.object({
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, { error: `密码至少 ${PASSWORD_MIN_LENGTH} 位` })
    .max(PASSWORD_MAX_LENGTH),
});
export type ResetUserPasswordRequest = z.output<typeof ResetUserPasswordRequestSchema>;

export const ResetUserPasswordResponseSchema = z.object({
  ok: z.literal(true),
});
export type ResetUserPasswordResponse = z.output<typeof ResetUserPasswordResponseSchema>;
