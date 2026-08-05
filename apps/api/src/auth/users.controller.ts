import { Controller, Get } from '@nestjs/common';
import { UsersListResponseSchema, type UsersListResponse } from '@monitor/contracts';
import { Roles } from '../common/roles.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { AuthService } from './auth.service';

/** 平台用户管理（内部/超管专属，spec §2.3：内部创建客户用户账号） */
@Roles('super_admin', 'internal')
@Controller('users')
export class UsersController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  @ZodResponse(UsersListResponseSchema)
  listUsers(): Promise<UsersListResponse> {
    return this.auth.listUsers();
  }
}
