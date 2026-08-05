import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@monitor/shared';

/** 邀请链接首次设密：token 为邀请链接携带的原始 token，一次性使用 */
export const SetPasswordRequestSchema = z.object({
  token: z.string().min(1, { error: '邀请链接无效' }),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, { error: `密码至少 ${PASSWORD_MIN_LENGTH} 位` })
    .max(PASSWORD_MAX_LENGTH),
});
export type SetPasswordRequest = z.output<typeof SetPasswordRequestSchema>;

export const SetPasswordResponseSchema = z.object({
  ok: z.literal(true),
});
export type SetPasswordResponse = z.output<typeof SetPasswordResponseSchema>;
