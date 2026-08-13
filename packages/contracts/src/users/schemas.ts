import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@monitor/shared';
import { UserSchema } from '../auth/schemas';

/**
 * 用户管理列表项：User + 账号状态 + 邀请类型（内部/超管管理界面用）。
 * inviteKind：客户创建（#50）产生的待激活账号 = 'customer'；项目成员邀请 = null。
 * 前端据此判断哪些未激活客户账号可重发邀请链接（grilling：链接再发放）。
 */
export const UserAdminSchema = UserSchema.extend({
  isActive: z.boolean(),
  inviteKind: z.enum(['customer']).nullable(),
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
 * 更新用户资料（#37/#38 + grilling 昵称编辑）：PATCH 部分语义，字段均可选——
 * description（null 清空，DB 列可空）+ role（平台角色互改，仅可赋值
 * super_admin/internal；customer 走邀请流程不可在此赋值，且不能改自己的角色）
 * + displayName（昵称：本人或超管可改，唯一性查重 409）。
 * 字段级权限在 service 层按 actor 判定（入口已开放到所有登录角色）。
 */
export const UpdateUserRequestSchema = z.object({
  description: z.string().max(35).nullable().optional(),
  role: z.enum(['super_admin', 'internal']).optional(),
  displayName: z.string().trim().min(1).max(64).optional(),
});
export type UpdateUserRequest = z.output<typeof UpdateUserRequestSchema>;

/**
 * 重发客户邀请（grilling：未激活客户链接再发放）：重新生成一次性 token——
 * 旧链接立即失效，有效期刷新为 7 天。仅超管可调用。
 */
export const ResendInviteResponseSchema = z.object({
  inviteUrl: z.string().url(),
  expiresAt: z.iso.datetime(),
});
export type ResendInviteResponse = z.output<typeof ResendInviteResponseSchema>;

export const UpdateUserResponseSchema = z.object({
  user: UserAdminSchema,
});
export type UpdateUserResponse = z.output<typeof UpdateUserResponseSchema>;
