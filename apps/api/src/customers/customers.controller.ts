import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  CustomerCreateRequestSchema,
  CustomerCreateResponseSchema,
  CustomerUpdateRequestSchema,
  CustomerUpdateResponseSchema,
  CustomersListResponseSchema,
  type CustomerCreateRequest,
  type CustomerCreateResponse,
  type CustomerUpdateRequest,
  type CustomerUpdateResponse,
  type CustomersListResponse,
} from '@monitor/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CustomersService } from './customers.service';

/**
 * 客户管理：
 * - 建客户 = 超管专属（spec §2.1/§2.4 customer:create）
 * - 编辑资料 = 内部+（customer:update，客户用户 403 —— #14 验收 ③）
 * - 列表 = 所有登录角色（内部看全部 + search；客户经 RLS 只见所属客户，#14 验收 ②③）
 */
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Roles('super_admin')
  @Post()
  @ZodResponse(CustomerCreateResponseSchema)
  create(
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(CustomerCreateRequestSchema)) body: CustomerCreateRequest,
  ): Promise<CustomerCreateResponse> {
    return this.customers.create(actor, body);
  }

  @Roles('super_admin', 'internal', 'customer_pm', 'customer_key_user', 'customer_user')
  @Get()
  @ZodResponse(CustomersListResponseSchema)
  list(@Query('search') search?: string): Promise<CustomersListResponse> {
    return this.customers.list(search);
  }

  @Roles('super_admin', 'internal')
  @Patch(':id')
  @ZodResponse(CustomerUpdateResponseSchema)
  update(
    // 非法 uuid → 400，避免 22P02 → 500
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(CustomerUpdateRequestSchema)) body: CustomerUpdateRequest,
  ): Promise<CustomerUpdateResponse> {
    return this.customers.update(actor, id, body);
  }
}
