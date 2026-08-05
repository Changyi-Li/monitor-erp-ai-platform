import { z } from 'zod';
import { USER_ROLES } from '@monitor/shared';

/** 用户对象——所有响应契约中 user 的形态，前后端共享 */
export const UserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  displayName: z.string().trim().min(1).max(64),
  role: z.enum(USER_ROLES),
  createdAt: z.iso.datetime(),
});
export type User = z.output<typeof UserSchema>;

/** 对齐 NestJS 默认异常体 */
export const ErrorResponseSchema = z.object({
  statusCode: z.number().int(),
  message: z.string().or(z.array(z.string())),
  error: z.string().optional(),
});
export type ApiError = z.output<typeof ErrorResponseSchema>;
