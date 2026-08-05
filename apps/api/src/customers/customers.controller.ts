import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  CustomerCreateRequestSchema,
  CustomerCreateResponseSchema,
  CustomersListResponseSchema,
  type CustomerCreateRequest,
  type CustomerCreateResponse,
  type CustomersListResponse,
} from '@monitor/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CustomersService } from './customers.service';

/** 客户管理：建客户 = 超管专属（spec §2.1/§2.4 customer:create）；列表 = 内部+ */
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

  @Roles('super_admin', 'internal')
  @Get()
  @ZodResponse(CustomersListResponseSchema)
  list(): Promise<CustomersListResponse> {
    return this.customers.list();
  }
}
