import { z } from 'zod';

/** 轮换式刷新：旧 refreshToken 生效一次，刷新后立即失效 */
export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequest = z.output<typeof RefreshRequestSchema>;

export const RefreshResponseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
});
export type RefreshResponse = z.output<typeof RefreshResponseSchema>;
