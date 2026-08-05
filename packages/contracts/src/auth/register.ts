import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@monitor/shared';
import { UserSchema } from './schemas';

/** 注册：注册成功只返回用户，不自动登录（demo 路径是注册完去登录页） */
export const RegisterRequestSchema = z.object({
  email: z.email({ error: '邮箱格式不正确' }),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, { error: `密码至少 ${PASSWORD_MIN_LENGTH} 位` })
    .max(PASSWORD_MAX_LENGTH),
  displayName: z.string().trim().min(1).max(64).optional(),
});
export type RegisterRequest = z.output<typeof RegisterRequestSchema>;

export const RegisterResponseSchema = z.object({
  user: UserSchema,
});
export type RegisterResponse = z.output<typeof RegisterResponseSchema>;
