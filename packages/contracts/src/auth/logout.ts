import { z } from 'zod';

/** access token 走 Authorization 头（Guard 校验），refreshToken 在 body 用于删除库中会话行 */
export const LogoutRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type LogoutRequest = z.output<typeof LogoutRequestSchema>;

/** 204 No Content */
export const LogoutResponseSchema = z.undefined();
export type LogoutResponse = z.output<typeof LogoutResponseSchema>;
