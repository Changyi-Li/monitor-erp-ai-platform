import { z } from 'zod';
import {
  CUSTOMER_INVITE_ROLES,
  INTERNAL_ROLES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USER_ROLES,
} from '@monitor/shared';
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
  role: z.enum(INTERNAL_ROLES),
});
export type CreateUserRequest = z.output<typeof CreateUserRequestSchema>;

export const CreateUserResponseSchema = z.object({
  user: UserAdminSchema,
});
export type CreateUserResponse = z.output<typeof CreateUserResponseSchema>;

/**
 * 更新用户资料（#37/#38 + grilling 昵称编辑）：PATCH 部分语义，字段均可选——
 * description（null 清空，DB 列可空）+ role（T3：全部 5 个平台角色可赋值，
 * 服务端按「同域互转」约束：客户三档互调、内部两值互改，customer ↔ internal 禁止
 * 互转 400；且不能改自己的角色）+ displayName（昵称：本人或超管可改，唯一性查重 409）。
 * 字段级权限在 service 层按 actor 判定（入口已开放到所有登录角色）。
 */
export const UpdateUserRequestSchema = z.object({
  description: z.string().max(35).nullable().optional(),
  role: z.enum(USER_ROLES).optional(),
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

/**
 * 客户 PM 邀请本公司用户（T6，spec-v1 US5 邀请半场）：
 * 新账号 = 待激活占位账号（不可登录）+ 邮箱绑定邀请链接（inviteKind='customer'，
 * /invite 页需输入被邀请邮箱才能激活）+ user_tenants 归属本公司。
 * 档位仅 customer_key_user / customer_user（customer_pm 档只能由建客户/超管产生，T3）。
 * 已注册邮箱 → 409（公司级邀请只建新账号；激活/加项目走成员流程）。
 */
export const InviteUserRequestSchema = z.object({
  email: z.email({ error: '邮箱格式不正确' }),
  displayName: z.string().trim().min(1).max(64).optional(),
  role: z.enum(CUSTOMER_INVITE_ROLES).default('customer_user'),
});
export type InviteUserRequest = z.output<typeof InviteUserRequestSchema>;

export const InviteUserResponseSchema = z.object({
  inviteUrl: z.string().url(),
  /** 邀请过期时间（7 天；过期后由清理 worker 删除，链接失效） */
  expiresAt: z.iso.datetime(),
  user: UserAdminSchema,
});
export type InviteUserResponse = z.output<typeof InviteUserResponseSchema>;

export const UpdateUserResponseSchema = z.object({
  user: UserAdminSchema,
});
export type UpdateUserResponse = z.output<typeof UpdateUserResponseSchema>;

/**
 * 账号停用/启用（T5，spec-v1 US5）：独立端点 PATCH /users/:id/status——
 * isActive 的权限语义与资料更新不同（超管任意账号 + customer_pm 本公司账号），
 * 不并入 UpdateUserRequest 以免混淆「任何登录角色可进」的 PATCH 入口。
 * 服务端防护：不能停用自己（409）；customer_pm 目标不在本公司 → 404（不可见语义）。
 */
export const UpdateUserStatusRequestSchema = z.object({
  isActive: z.boolean(),
});
export type UpdateUserStatusRequest = z.output<typeof UpdateUserStatusRequestSchema>;

export const UpdateUserStatusResponseSchema = z.object({
  user: UserAdminSchema,
});
export type UpdateUserStatusResponse = z.output<typeof UpdateUserStatusResponseSchema>;
