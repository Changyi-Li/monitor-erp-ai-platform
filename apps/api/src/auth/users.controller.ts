import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  CreateUserRequestSchema,
  CreateUserResponseSchema,
  UsersListResponseSchema,
  type CreateUserRequest,
  type CreateUserResponse,
  type UsersListResponse,
} from '@monitor/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService } from './auth.service';

/** 平台用户管理（内部/超管专属，spec §2.3：内部创建客户用户账号） */
@Roles('super_admin', 'internal')
@Controller('users')
export class UsersController {
  constructor(private readonly auth: AuthService) {}

  /** 超管创建内部用户（US-3）：方法级 @Roles 覆盖类级——internal 只能看列表不能建号 */
  @Post()
  @Roles('super_admin')
  @ZodResponse(CreateUserResponseSchema)
  createUser(
    @Body(new ZodValidationPipe(CreateUserRequestSchema)) body: CreateUserRequest,
    @CurrentUser() actor: AuthUser,
  ): Promise<CreateUserResponse> {
    return this.auth.createUser(body, actor);
  }

  @Get()
  @ZodResponse(UsersListResponseSchema)
  listUsers(): Promise<UsersListResponse> {
    return this.auth.listUsers();
  }
}
