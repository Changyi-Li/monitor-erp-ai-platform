import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  CreateUserRequestSchema,
  CreateUserResponseSchema,
  ResetUserPasswordRequestSchema,
  ResetUserPasswordResponseSchema,
  UpdateUserRequestSchema,
  UpdateUserResponseSchema,
  UsersListResponseSchema,
  type CreateUserRequest,
  type CreateUserResponse,
  type ResetUserPasswordRequest,
  type ResetUserPasswordResponse,
  type UpdateUserRequest,
  type UpdateUserResponse,
  type UsersListResponse,
} from '@monitor/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService } from './auth.service';

// 模块级常量（stages/minutes 同模式）：内联 new 在参数装饰器求值时实例化会丢 schema，
// Nest 11 参数管道解析后用到的实例无 schema → transform 抛 TypeError（500）
const uuidParam = new ZodValidationPipe(z.uuid());

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

  /** 超管更新用户资料（#37）：当前仅 description；方法级 @Roles 覆盖类级 */
  @Patch(':id')
  @Roles('super_admin')
  @ZodResponse(UpdateUserResponseSchema)
  updateUser(
    // 非法 uuid → 400，避免 22P02 → 500（同客户 PATCH 模式）
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateUserRequestSchema)) body: UpdateUserRequest,
    @CurrentUser() actor: AuthUser,
  ): Promise<UpdateUserResponse> {
    return this.auth.updateUser(id, body, actor);
  }

  /**
   * 重置用户密码（#39）：改自己 = 任何登录角色（方法级 @Roles 覆盖类级，customer 也能进）；
   * 改别人 = 仅超管（service 层目标鉴权）。
   */
  @Post(':id/reset-password')
  // 重置 = 更新语义（非创建资源），返回 200 而非 POST 默认 201
  @HttpCode(200)
  @Roles('super_admin', 'internal', 'customer')
  @ZodResponse(ResetUserPasswordResponseSchema)
  resetUserPassword(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(ResetUserPasswordRequestSchema)) body: ResetUserPasswordRequest,
    @CurrentUser() actor: AuthUser,
  ): Promise<ResetUserPasswordResponse> {
    return this.auth.resetUserPassword(id, body, actor);
  }
}
