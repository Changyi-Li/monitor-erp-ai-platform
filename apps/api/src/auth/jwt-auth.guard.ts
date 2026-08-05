import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import { IS_PUBLIC_KEY } from '../common/public.decorator';
import type { AccessTokenPayload } from './token.service';

/** 全局 JWT Guard：Bearer token 校验 + 挂 req.user；@Public() 路由放行 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = extractBearer(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException('未登录');
    }
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
      (request as FastifyRequest & { user: AccessTokenPayload }).user = {
        sub: payload.sub,
        email: payload.email,
        // 旧 token 无 role 声明 → 按 internal 处理（短 TTL 缓解，见 ADR-0001）
        role: payload.role ?? 'internal',
      };
      return true;
    } catch {
      throw new UnauthorizedException('登录已过期');
    }
  }
}

function extractBearer(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}
