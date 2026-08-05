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

export const MembersListResponseSchema = z.object({
  members: z.array(MemberSchema),
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
