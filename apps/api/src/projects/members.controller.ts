import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  MemberInviteRequestSchema,
  MemberInviteResponseSchema,
  MembersListResponseSchema,
  MemberUpdateRequestSchema,
  MemberUpdateResponseSchema,
  type MemberInviteRequest,
  type MemberInviteResponse,
  type MembersListResponse,
  type MemberUpdateRequest,
} from '@monitor/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MembersService } from './members.service';

/** 项目成员管理：准入（内部/该项目 active PM）在 service 层按成员表解析 */
@Controller('projects/:id/members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @ZodResponse(MembersListResponseSchema)
  list(
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<MembersListResponse> {
    return this.members.list(id, actor);
  }

  @Post()
  @ZodResponse(MemberInviteResponseSchema)
  invite(
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(MemberInviteRequestSchema)) body: MemberInviteRequest,
  ): Promise<MemberInviteResponse> {
    return this.members.invite(id, actor, body);
  }

  @Patch(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ZodResponse(MemberUpdateResponseSchema) // 204 无响应体
  update(
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @Param('userId', new ZodValidationPipe(z.uuid())) userId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(MemberUpdateRequestSchema)) body: MemberUpdateRequest,
  ): Promise<void> {
    return this.members.update(id, userId, actor, body);
  }
}
