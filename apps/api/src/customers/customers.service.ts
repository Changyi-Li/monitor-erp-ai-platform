import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, ilike, or } from 'drizzle-orm';
import {
  type Customer,
  type CustomerCreateRequest,
  type CustomerCreateResponse,
  type CustomerUpdateRequest,
  type CustomerUpdateResponse,
  type CustomersListResponse,
} from '@monitor/contracts';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/current-user.decorator';
import { DRIZZLE, type Database } from '../database/database.module';
import { customers, type CustomerRow } from '../database/schema';

/** 客户（租户注册表）：建客户为超管专属（customer:create），维护归内部 */
@Injectable()
export class CustomersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async create(
    actor: AuthUser,
    input: CustomerCreateRequest,
  ): Promise<CustomerCreateResponse> {
    const [row] = await this.db
      .insert(customers)
      .values({
        name: input.name,
        industry: input.industry ?? null,
        region: input.region ?? null,
      })
      .returning();
    if (!row) {
      throw new Error('创建客户失败');
    }
    await this.audit.record(AUDIT_ACTIONS.CUSTOMER_CREATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'customer',
      resourceId: row.id,
      metadata: { name: row.name },
    });
    return { customer: toCustomerDto(row) };
  }

  /**
   * 列表：内部/超管看全部（可按名称/行业/地域模糊搜索）；客户用户经 RLS 只见自己那行
   * （列表端点放开给 customer 角色即"查看所属客户资料"，#14 验收 ③）。
   */
  async list(search?: string): Promise<CustomersListResponse> {
    const keyword = search?.trim();
    const rows = keyword
      ? await this.db
          .select()
          .from(customers)
          .where(
            and(
              or(
                ilike(customers.name, `%${escapeLike(keyword)}%`),
                ilike(customers.industry, `%${escapeLike(keyword)}%`),
                ilike(customers.region, `%${escapeLike(keyword)}%`),
              ),
            ),
          )
          .orderBy(customers.createdAt)
      : await this.db.select().from(customers).orderBy(customers.createdAt);
    return { customers: rows.map(toCustomerDto) };
  }

  /**
   * 编辑客户资料（内部/超管专属，客户用户由 @Roles 挡 403）。
   * PATCH 部分更新：undefined 不动、null 清空（industry/region）；空对象 = 无操作。
   */
  async update(
    actor: AuthUser,
    id: string,
    input: CustomerUpdateRequest,
  ): Promise<CustomerUpdateResponse> {
    // 先查后改：行不存在 → 404（uuid 合法性已由 controller ZodValidationPipe 挡 400）
    const [existing] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    if (!existing) {
      throw new NotFoundException('客户不存在');
    }
    // 空对象 = 无操作（set({}) 会生成非法 SQL）
    if (
      input.name === undefined &&
      input.industry === undefined &&
      input.region === undefined
    ) {
      return { customer: toCustomerDto(existing) };
    }
    const [row] = await this.db
      .update(customers)
      .set({
        name: input.name,
        industry: input.industry,
        region: input.region,
      })
      .where(eq(customers.id, id))
      .returning();
    if (!row) {
      throw new NotFoundException('客户不存在');
    }
    await this.audit.record(AUDIT_ACTIONS.CUSTOMER_UPDATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'customer',
      resourceId: row.id,
      metadata: { name: row.name },
    });
    return { customer: toCustomerDto(row) };
  }
}

/** 转义 LIKE 通配符（% _ \），防用户输入当模式；Postgres ILIKE 默认 escape 为反斜杠 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** DB 行 → 契约 Customer：Date toISOString() */
function toCustomerDto(row: CustomerRow): Customer {
  return {
    id: row.id,
    name: row.name,
    industry: row.industry ?? null,
    region: row.region ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
