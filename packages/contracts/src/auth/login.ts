import { z } from 'zod';
import { UserSchema } from './schemas';

export const LoginRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1, { error: '请输入密码' }),
});
export type LoginRequest = z.output<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  user: UserSchema,
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** access token 有效期（秒），供前端预判刷新时机 */
  expiresIn: z.number().int().positive(),
});
export type LoginResponse = z.output<typeof LoginResponseSchema>;
