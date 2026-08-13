import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  InviteInfoResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LogoutRequestSchema,
  LogoutResponseSchema,
  MeResponseSchema,
  RefreshRequestSchema,
  RefreshResponseSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  SetPasswordRequestSchema,
  SetPasswordResponseSchema,
  type InviteInfoResponse,
  type LoginRequest,
  type LoginResponse,
  type LogoutRequest,
  type MeResponse,
  type RefreshRequest,
  type RefreshResponse,
  type RegisterRequest,
  type RegisterResponse,
  type SetPasswordRequest,
  type SetPasswordResponse,
} from '@monitor/contracts';
import { ConfigService } from '@nestjs/config';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { Public } from '../common/public.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 自助注册默认关闭（AUTH_SELF_REGISTER=false）——建号唯一入口：超管建内部用户
   * （POST /users，US-3）/ 项目邀请客户（US-4）。避免客户拿到网址自助注册成内部账号。
   * 开关仅留给开发/测试环境（e2e 的 .env.test 打开）。
   */
  @Public()
  @Post('register')
  @ZodResponse(RegisterResponseSchema)
  register(
    @Body(new ZodValidationPipe(RegisterRequestSchema)) body: RegisterRequest,
  ): Promise<RegisterResponse> {
    // 显式字符串比较：ConfigService 不做布尔解析，'false' 字符串是 truthy
    if (this.config.get<string>('AUTH_SELF_REGISTER') !== 'true') {
      throw new ForbiddenException('注册已关闭：账号由管理员创建或通过邀请链接加入');
    }
    return this.auth.register(body);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(LoginResponseSchema)
  login(
    @Body(new ZodValidationPipe(LoginRequestSchema)) body: LoginRequest,
    @Req() req: FastifyRequest,
  ): Promise<LoginResponse> {
    return this.auth.login(body, req.ip);
  }

  @Public()
  @Post('set-password')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(SetPasswordResponseSchema)
  setPassword(
    @Body(new ZodValidationPipe(SetPasswordRequestSchema)) body: SetPasswordRequest,
    @Req() req: FastifyRequest,
  ): Promise<SetPasswordResponse> {
    return this.auth.setPassword(body, req.ip);
  }

  /** 邀请链接类型查询（issue #50）：/invite 接受页区分客户/成员邀请表单
   *  （空/无效 token 由 service 统一 400 文案，不在此重复校验） */
  @Public()
  @Get('invite-info')
  @ZodResponse(InviteInfoResponseSchema)
  inviteInfo(@Query('token') token?: string): Promise<InviteInfoResponse> {
    return this.auth.inviteInfo(token ?? '');
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(RefreshResponseSchema)
  refresh(
    @Body(new ZodValidationPipe(RefreshRequestSchema)) body: RefreshRequest,
  ): Promise<RefreshResponse> {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ZodResponse(LogoutResponseSchema)
  logout(
    @Body(new ZodValidationPipe(LogoutRequestSchema)) body: LogoutRequest,
  ): Promise<void> {
    return this.auth.logout(body.refreshToken);
  }

  @Get('me')
  @ZodResponse(MeResponseSchema)
  me(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    return this.auth.me(user.sub);
  }
}
