import { Inject, Injectable } from '@nestjs/common';
import {
  type Customer,
  type CustomerCreateRequest,
  type CustomerCreateResponse,
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

  /** 内部/超管（建项目表单选客户用） */
  async list(): Promise<CustomersListResponse> {
    const rows = await this.db.select().from(customers).orderBy(customers.createdAt);
    return { customers: rows.map(toCustomerDto) };
  }
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
