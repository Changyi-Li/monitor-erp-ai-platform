import { z } from 'zod';
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
