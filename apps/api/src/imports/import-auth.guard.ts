import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from '../common/current-user.decorator';

/** API-key 通道哨兵用户（service 层以 sub === 此值判定「外部系统」身份：审计 actorRole='system'、createdById=null） */
export const IMPORT_SYSTEM_SUB = '00000000-0000-0000-0000-000000000000';

/**
 * 导入通道认证（issue #25）：@Public 路由专属 Guard（跳过全局 JWT Guard 后自解析）。
 * 双通道：
 * ① x-api-key header === env IMPORT_API_KEY（未配置则此通道 401）→ 哨兵内部用户；
 * ② 否则 Bearer JWT（内部用户调试页通道）——客户 token 能过此 Guard，由 service 层
 *    kb:edit 断言拒（403）。
 * 都失败 → 401「缺少导入凭证」。
 */
@Injectable()
export class ImportAuthGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      const expected = this.config.get<string>('IMPORT_API_KEY');
      if (!expected) {
        throw new UnauthorizedException('导入 API 未启用（缺少 IMPORT_API_KEY 配置）');
      }
      if (apiKey !== expected) {
        throw new UnauthorizedException('导入凭证无效');
      }
      (request as FastifyRequest & { user: AuthUser }).user = {
        sub: IMPORT_SYSTEM_SUB,
        email: 'import-api',
        role: 'internal',
      };
      return true;
    }

    const bearer = request.headers.authorization;
    const token = extractBearer(bearer);
    if (!token) {
      throw new UnauthorizedException('缺少导入凭证（x-api-key 或 Bearer token）');
    }
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; email: string; role?: string }>(
        token,
      );
      (request as FastifyRequest & { user: AuthUser }).user = {
        sub: payload.sub,
        email: payload.email,
        // 旧 token 无 role 声明 → 按 internal 处理（同 jwt-auth.guard）
        role: (payload.role ?? 'internal') as AuthUser['role'],
      };
      return true;
    } catch {
      throw new UnauthorizedException('导入凭证无效');
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
