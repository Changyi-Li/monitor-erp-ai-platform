import { z } from 'zod';
import { UserSchema } from './schemas';

export const MeResponseSchema = z.object({
  user: UserSchema,
});
export type MeResponse = z.output<typeof MeResponseSchema>;
