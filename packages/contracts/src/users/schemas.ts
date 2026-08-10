import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@monitor/shared';
import { UserSchema } from '../auth/schemas';

/** 用户管理列表项：User + 账号状态（内部/超管管理界面用） */
export const UserAdminSchema = UserSchema.extend({
  isActive: z.boolean(),
});
export type UserAdmin = z.output<typeof UserAdminSchema>;

export const UsersListResponseSchema = z.object({
  users: z.array(UserAdminSchema),
});
export type UsersListResponse = z.output<typeof UsersListResponseSchema>;

/**
 * 超管创建内部用户（US-3）：角色仅限 super_admin / internal（customer 账号走项目成员邀请）；
 * 密码规则与 register 一致（8-128 位，无复杂度正则）。
 */
export const CreateUserRequestSchema = z.object({
  email: z.email({ error: '邮箱格式不正确' }),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, { error: `密码至少 ${PASSWORD_MIN_LENGTH} 位` })
    .max(PASSWORD_MAX_LENGTH),
  displayName: z.string().trim().min(1).max(64).optional(),
  role: z.enum(['super_admin', 'internal']),
});
export type CreateUserRequest = z.output<typeof CreateUserRequestSchema>;

export const CreateUserResponseSchema = z.object({
  user: UserAdminSchema,
});
export type CreateUserResponse = z.output<typeof CreateUserResponseSchema>;

/**
 * 超管更新用户资料（#37）：PATCH 语义，当前仅 description；
 * null 表示清空描述（DB 列可空）。
 */
export const UpdateUserRequestSchema = z.object({
  description: z.string().max(35).nullable(),
});
export type UpdateUserRequest = z.output<typeof UpdateUserRequestSchema>;

export const UpdateUserResponseSchema = z.object({
  user: UserAdminSchema,
});
export type UpdateUserResponse = z.output<typeof UpdateUserResponseSchema>;
