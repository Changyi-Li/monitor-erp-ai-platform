import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  CreateUserRequestSchema,
  CreateUserResponseSchema,
  InviteUserRequestSchema,
  InviteUserResponseSchema,
  ResendInviteResponseSchema,
  ResetUserPasswordRequestSchema,
  ResetUserPasswordResponseSchema,
  UpdateUserRequestSchema,
  UpdateUserResponseSchema,
  UpdateUserStatusRequestSchema,
  UpdateUserStatusResponseSchema,
  UsersListResponseSchema,
  type CreateUserRequest,
  type CreateUserResponse,
  type InviteUserRequest,
  type InviteUserResponse,
  type ResendInviteResponse,
  type ResetUserPasswordRequest,
  type ResetUserPasswordResponse,
  type UpdateUserRequest,
  type UpdateUserResponse,
  type UpdateUserStatusRequest,
  type UpdateUserStatusResponse,
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
 * 平台用户管理。T4/#53 对公司开放：类级默认内部/超管，各方法按语义覆盖——
 * 列表（GET）所有客户角色可见本公司全部账号（只读花名册）；
 * 建号/邀请仍限超管/customer_pm；更新（昵称本人可改）、重置密码（自己）所有登录角色
 * 可进，字段级权限在 service 层判定。
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

  // T4/#53：用户管理页对公司开放——方法级 @Roles 覆盖类级：所有客户角色
  // 可见本公司全部账号（service 层按租户过滤；公司花名册只读，管理操作仍按角色收着）
  @Get()
  @Roles('super_admin', 'internal', 'customer_pm', 'customer_key_user', 'customer_user')
  @ZodResponse(UsersListResponseSchema)
  listUsers(@CurrentUser() actor: AuthUser): Promise<UsersListResponse> {
    return this.auth.listUsers(actor);
  }

  /**
   * 客户 PM 邀请本公司用户（T6，spec-v1 US5 邀请半场）：方法级 @Roles 覆盖类级——
   * 仅 customer_pm（RolesGuard 对 super_admin 全放行，service 层显式拒绝——
   * 超管邀客户用户需目标公司选择器，留待后续票）；service 层按租户归属本公司，
   * 档位限 customer_key_user/customer_user（契约层限定，customer_pm 档由建客户/超管产生）。
   * 响应含邀请链接（7 天有效、绑定邮箱）供复制分发。
   */
  @Post('invite')
  @Roles('customer_pm')
  @ZodResponse(InviteUserResponseSchema)
  inviteUser(
    @Body(new ZodValidationPipe(InviteUserRequestSchema)) body: InviteUserRequest,
    @CurrentUser() actor: AuthUser,
  ): Promise<InviteUserResponse> {
    return this.auth.inviteCompanyUser(body, actor);
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
   * 账号停用/启用（T5，spec-v1 US5）：方法级 @Roles 覆盖类级——
   * 超管任何账号；customer_pm 本公司账号（service 层租户校验，跨公司 404）；
   * internal/customer_key_user/customer_user 拒绝。服务层防自己（409）。
   */
  @Patch(':id/status')
  @Roles('super_admin', 'customer_pm')
  @ZodResponse(UpdateUserStatusResponseSchema)
  updateUserStatus(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateUserStatusRequestSchema)) body: UpdateUserStatusRequest,
    @CurrentUser() actor: AuthUser,
  ): Promise<UpdateUserStatusResponse> {
    return this.auth.updateUserStatus(id, body, actor);
  }

  /**
   * 重发客户邀请（grilling：未激活客户链接再发放）：超管任何客户账号；
   * customer_pm 本公司账号（T6：service 层租户校验，他司 404；不能重发本公司
   * 其他 PM 的邀请 403，与 T5 停用语义一致）。重新生成 token——旧链接立即
   * 失效，有效期刷新 7 天；已激活/非客户邀请账号 → 409。
   */
  @Post(':id/resend-invite')
  @HttpCode(200)
  @Roles('super_admin', 'customer_pm')
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
