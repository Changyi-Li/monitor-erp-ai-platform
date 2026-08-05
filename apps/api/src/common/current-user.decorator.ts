import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export interface AuthUser {
  sub: string;
  email: string;
}

/** 取 JWT Guard 挂在 request.user 上的已认证用户 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    return (request as FastifyRequest & { user: AuthUser }).user;
  },
);
