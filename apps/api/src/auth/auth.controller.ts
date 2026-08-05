import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
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
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { Public } from '../common/public.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @ZodResponse(RegisterResponseSchema)
  register(
    @Body(new ZodValidationPipe(RegisterRequestSchema)) body: RegisterRequest,
  ): Promise<RegisterResponse> {
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
