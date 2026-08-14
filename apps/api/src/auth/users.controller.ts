import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  CreateUserRequestSchema,
  CreateUserResponseSchema,
  ResendInviteResponseSchema,
  ResetUserPasswordRequestSchema,
  ResetUserPasswordResponseSchema,
  UpdateUserRequestSchema,
  UpdateUserResponseSchema,
  UsersListResponseSchema,
  type CreateUserRequest,
  type CreateUserResponse,
  type ResendInviteResponse,
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

/**
 * 平台用户管理。T4 对公司开放：类级默认内部/超管，各方法按语义覆盖——
 * 列表（GET）customer_pm 可见本公司账号；建号/重发邀请仍仅超管；
 * 更新（昵称本人可改）、重置密码（自己）所有登录角色可进，字段级权限在 service 层判定。
 */
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

  // T4：用户管理页对公司开放——方法级 @Roles 覆盖类级，customer_pm 可见（本公司账号，
  // service 层按租户过滤）；customer_key_user/customer_user 仍拒绝
  @Get()
  @Roles('super_admin', 'internal', 'customer_pm')
  @ZodResponse(UsersListResponseSchema)
  listUsers(@CurrentUser() actor: AuthUser): Promise<UsersListResponse> {
    return this.auth.listUsers(actor);
  }

  /**
   * 更新用户资料（#37 + grilling 昵称编辑）：方法级 @Roles 覆盖类级——
   * 入口开放到所有登录角色（昵称本人可改），字段级权限在 service 层按 actor 判定
   * （改别人仅超管；description/role 仅超管；role 另有 self/customer 防护）。
   */
  @Patch(':id')
  @Roles('super_admin', 'internal', 'customer_pm', 'customer_key_user', 'customer_user')
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
   * 重发客户邀请（grilling：未激活客户链接再发放）：仅超管。
   * 重新生成 token——旧链接立即失效，有效期刷新 7 天；已激活/非客户邀请账号 → 409。
   */
  @Post(':id/resend-invite')
  @HttpCode(200)
  @Roles('super_admin')
  @ZodResponse(ResendInviteResponseSchema)
  resendInvite(
    @Param('id', uuidParam) id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<ResendInviteResponse> {
    return this.auth.resendInviteUser(id, actor);
  }

  /**
   * 重置用户密码（#39）：改自己 = 任何登录角色（方法级 @Roles 覆盖类级，customer 也能进）；
   * 改别人 = 仅超管（service 层目标鉴权）。
   */
  @Post(':id/reset-password')
  // 重置 = 更新语义（非创建资源），返回 200 而非 POST 默认 201
  @HttpCode(200)
  @Roles('super_admin', 'internal', 'customer_pm', 'customer_key_user', 'customer_user')
  @ZodResponse(ResetUserPasswordResponseSchema)
  resetUserPassword(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(ResetUserPasswordRequestSchema)) body: ResetUserPasswordRequest,
    @CurrentUser() actor: AuthUser,
  ): Promise<ResetUserPasswordResponse> {
    return this.auth.resetUserPassword(id, body, actor);
  }
}
