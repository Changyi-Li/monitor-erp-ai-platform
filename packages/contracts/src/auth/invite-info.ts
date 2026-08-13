import { z } from 'zod';

/**
 * 邀请链接类型查询（issue #50）：前端 /invite 接受页据此决定表单形状。
 * - customer = 客户邀请（创建客户时生成，激活需校验邮箱与绑定一致）
 * - project  = 项目成员邀请（现有，激活无需邮箱）
 * email 为 token 绑定的邮箱（两种邀请都有占位用户行），供前端预填/展示。
 */
export const InviteInfoResponseSchema = z.object({
  kind: z.enum(['customer', 'project']),
  email: z.email(),
});
export type InviteInfoResponse = z.output<typeof InviteInfoResponseSchema>;
