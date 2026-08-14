import { z } from 'zod';
import { CUSTOMER_INVITE_ROLES, CUSTOMER_ROLES } from '@monitor/shared';

/**
 * 项目成员（user + project，spec §2.1"项目成员 = 用户 + 项目 + 角色"）。
 * 角色拆分后（T2）：project_members.role 退役，role 字段反映账号的平台角色
 * （成员均为客户用户 → customer 三档）。email/displayName 为 users 表联查结果。
 */
export const MemberSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  userId: z.uuid(),
  role: z.enum(CUSTOMER_ROLES),
  isActive: z.boolean(),
  email: z.email(),
  displayName: z.string().trim().min(1).max(64),
  createdAt: z.iso.datetime(),
});
export type Member = z.output<typeof MemberSchema>;

/**
 * 待激活邀请（issue #42）：已发邀请链接但用户未点击设密激活的账号。
 * 判据 = 用户账号未激活且持有邀请 token（members 中的停用成员不在此列）。
 * userId 供重发/取消邀请（#43）定位账号。
 */
export const PendingInviteSchema = z.object({
  userId: z.uuid(),
  email: z.email(),
  displayName: z.string().trim().min(1).max(64),
  role: z.enum(CUSTOMER_ROLES),
  /** 首次邀请时间（成员行创建时间） */
  invitedAt: z.iso.datetime(),
  /** 邀请过期时间（7 天；过期后由清理 worker 删除，链接失效） */
  expiresAt: z.iso.datetime(),
});
export type PendingInvite = z.output<typeof PendingInviteSchema>;

/**
 * 成员列表分两类（issue #42）：members = 真实成员（已设密激活，含停用成员）；
 * pendingInvites = 待激活邀请（已发链接、未点击设密）。
 */
export const MembersListResponseSchema = z.object({
  members: z.array(MemberSchema),
  pendingInvites: z.array(PendingInviteSchema),
});
export type MembersListResponse = z.output<typeof MembersListResponseSchema>;

/**
 * 邀请成员（唯一建号入口）。role = 新账号的平台角色档位（customer_key_user /
 * customer_user；customer_pm 档只能由建客户/超管产生，T3）。role 仅用于新账号
 * 创建——已激活用户直接加入项目（inviteUrl=null，账号角色保持不动）。
 * 成员管理权 = 平台角色 customer_pm（T2，权限判定完全基于平台角色）。
 */
export const MemberInviteRequestSchema = z.object({
  email: z.email({ error: '邮箱格式不正确' }),
  displayName: z.string().trim().min(1).max(64).optional(),
  // 仅新账号创建消费；重发邀请（已存在账号）不改变角色，可省略（default 兜底）。
  // 显式传 customer_pm 档 → 契约拒绝（该档只能由建客户/超管产生，T3）
  role: z.enum(CUSTOMER_INVITE_ROLES).default('customer_user'),
});
export type MemberInviteRequest = z.output<typeof MemberInviteRequestSchema>;

export const MemberInviteResponseSchema = z.object({
  member: MemberSchema,
  inviteUrl: z.string().url().nullable(),
});
export type MemberInviteResponse = z.output<typeof MemberInviteResponseSchema>;

/** 停用/启用：只翻 project_members.is_active，不碰账号级 users.is_active */
export const MemberUpdateRequestSchema = z.object({
  isActive: z.boolean(),
});
export type MemberUpdateRequest = z.output<typeof MemberUpdateRequestSchema>;

/** 204 No Content（与 logout 同模式） */
export const MemberUpdateResponseSchema = z.undefined();
export type MemberUpdateResponse = z.output<typeof MemberUpdateResponseSchema>;

/**
 * 取消邀请（issue #43）：删除待激活客户账号（客户归属与成员关系级联清除），
 * 旧邀请链接立即失效。仅待激活邀请可取消；已激活成员走停用操作。
 * 响应 204 No Content（与停用同模式）。
 */
export const MemberCancelInviteResponseSchema = z.undefined();
export type MemberCancelInviteResponse = z.output<typeof MemberCancelInviteResponseSchema>;
