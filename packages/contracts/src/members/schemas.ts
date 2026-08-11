import { z } from 'zod';
import { PROJECT_ROLES } from '@monitor/shared';

/**
 * 项目成员（user + project + role，spec §2.1"项目成员 = 用户 + 项目 + 角色"）。
 * email/displayName 为 users 表联查结果，前端列表展示用。
 */
export const MemberSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  userId: z.uuid(),
  role: z.enum(PROJECT_ROLES),
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
  role: z.enum(PROJECT_ROLES),
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
 * 邀请成员（唯一建号入口）：内部可建任一项目角色；PM 只能 key_user/regular_user
 * （不可升级角色——project_manager 只能由内部授予）。inviteUrl 为 null 表示
 * 该邮箱已是同租户活跃用户，直接加入项目（无需设密）。
 */
export const MemberInviteRequestSchema = z.object({
  email: z.email({ error: '邮箱格式不正确' }),
  displayName: z.string().trim().min(1).max(64).optional(),
  role: z.enum(PROJECT_ROLES),
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
