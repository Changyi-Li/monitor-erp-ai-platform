import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { lastValueFrom, of, type Observable } from 'rxjs';
import type { AccessTokenPayload } from '../auth/token.service';
import { IS_PUBLIC_KEY } from '../common/public.decorator';
import { RAW_DB, type Database } from './database.module';
import { userTenants } from './schema';
import { TenantContextService } from './tenant-context.service';

/** 无成员关系的客户用户哨兵：所有租户级查询返回空/404（fail closed，不报 500） */
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * 多租户核心接缝：每请求一个事务，事务内 SET LOCAL 注入租户 GUC（RLS 依据），
 * 业务 handler 的全部查询经 DRIZZLE 代理转发到该事务连接。
 * - 内部用户：只设 app.is_internal=true（旁路）。绝不设 app.tenant_id——
 *   空串 cast uuid 会 22P02 报 500，未设置则 RLS fail closed 零行。
 * - 客户用户：事务外 RAW_DB 解析成员关系（user_tenants 无 RLS），取第一个
 *   成员关系；多客户用户的租户切换留后续 ticket。
 * - @Public() 路由（register/login/refresh）：不建事务、不设 GUC。
 * SET LOCAL 随事务结束自动失效，无连接池会话变量泄漏。
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContextService,
    @Inject(RAW_DB) private readonly base: Database,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return next.handle();
    }

    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AccessTokenPayload }>();
    const user = request.user;
    if (!user) {
      return next.handle(); // 防御性：Guard 已拦截未认证请求
    }

    const isInternal = user.role !== 'customer';
    let tenantId: string | null = null;
    if (!isInternal) {
      const rows = await this.base
        .select({ customerId: userTenants.customerId })
        .from(userTenants)
        .where(eq(userTenants.userId, user.sub))
        .limit(1);
      tenantId = rows[0]?.customerId ?? ZERO_UUID;
    }

    const result = await this.base.transaction(async (tx) => {
      if (isInternal) {
        await tx.execute(sql`select set_config('app.is_internal', 'true', true)`);
      } else {
        await tx.execute(sql`
          select set_config('app.tenant_id', ${tenantId}, true),
                 set_config('app.is_internal', 'false', true)
        `);
      }
      return this.tenantContext.run(
        { tx, tenantId, isInternal, userId: user.sub },
        () => lastValueFrom(next.handle()),
      );
    });

    return of(result);
  }
}
