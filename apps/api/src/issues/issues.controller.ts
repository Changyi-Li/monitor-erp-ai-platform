import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
  AssigneesListResponseSchema,
  IssueCommentCreateResponseSchema,
  IssueCommentRequestSchema,
  IssueCreateRequestSchema,
  IssueCreateResponseSchema,
  IssueGetResponseSchema,
  IssueLinkRequestSchema,
  IssueLinkResponseSchema,
  IssueTransitionRequestSchema,
  IssueTransitionResponseSchema,
  IssueUpdateRequestSchema,
  IssueUpdateResponseSchema,
  IssuesListQuerySchema,
  IssuesListResponseSchema,
  type AssigneesListResponse,
  type IssueCommentCreateResponse,
  type IssueCommentRequest,
  type IssueCreateRequest,
  type IssueCreateResponse,
  type IssueGetResponse,
  type IssueLinkRequest,
  type IssueLinkResponse,
  type IssueTransitionRequest,
  type IssueTransitionResponse,
  type IssueUpdateRequest,
  type IssueUpdateResponse,
  type IssuesListQuery,
  type IssuesListResponse,
} from '@monitor/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { IssuesService } from './issues.service';

/**
 * 问题清单（issue #15）：嵌套在项目下（数据边界 = 项目）。
 * 项目级权限全部在 service 层按成员表解析（见 issues.service 注释），本层只有
 * 契约校验（uuid 挡 400 防 22P02、query/body zod 校验）。
 */
@Controller('projects/:projectId/issues')
export class IssuesController {
  constructor(private readonly issues: IssuesService) {}

  @Get()
  @ZodResponse(IssuesListResponseSchema)
  list(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @CurrentUser() actor: AuthUser,
    @Query(new ZodValidationPipe(IssuesListQuerySchema)) query: IssuesListQuery,
  ): Promise<IssuesListResponse> {
    return this.issues.list(projectId, actor, query);
  }

  @Post()
  @ZodResponse(IssueCreateResponseSchema)
  create(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(IssueCreateRequestSchema)) body: IssueCreateRequest,
  ): Promise<IssueCreateResponse> {
    return this.issues.create(projectId, actor, body);
  }

  /** 指派候选（先于 :issueId 注册，静态段优先） */
  @Get('assignees')
  @ZodResponse(AssigneesListResponseSchema)
  assignees(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<AssigneesListResponse> {
    return this.issues.listAssignees(projectId, actor);
  }

  @Get(':issueId')
  @ZodResponse(IssueGetResponseSchema)
  get(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Param('issueId', new ZodValidationPipe(z.uuid())) issueId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<IssueGetResponse> {
    return this.issues.getById(projectId, issueId, actor);
  }

  @Patch(':issueId')
  @ZodResponse(IssueUpdateResponseSchema)
  update(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Param('issueId', new ZodValidationPipe(z.uuid())) issueId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(IssueUpdateRequestSchema)) body: IssueUpdateRequest,
  ): Promise<IssueUpdateResponse> {
    return this.issues.update(projectId, issueId, actor, body);
  }

  @Post(':issueId/transition')
  @HttpCode(HttpStatus.OK) // 状态流转非创建资源，200（@Post 默认 201）
  @ZodResponse(IssueTransitionResponseSchema)
  transition(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Param('issueId', new ZodValidationPipe(z.uuid())) issueId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(IssueTransitionRequestSchema)) body: IssueTransitionRequest,
  ): Promise<IssueTransitionResponse> {
    return this.issues.transition(projectId, issueId, actor, body);
  }

  @Post(':issueId/comments')
  @ZodResponse(IssueCommentCreateResponseSchema)
  addComment(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Param('issueId', new ZodValidationPipe(z.uuid())) issueId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(IssueCommentRequestSchema)) body: IssueCommentRequest,
  ): Promise<IssueCommentCreateResponse> {
    return this.issues.addComment(projectId, issueId, actor, body.content);
  }

  /** 关联蓝图/会议纪要/知识库文档（issue #20，spec 42；issue:manage = 内部 + PM） */
  @Post(':issueId/links')
  @ZodResponse(IssueLinkResponseSchema)
  addLink(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Param('issueId', new ZodValidationPipe(z.uuid())) issueId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(IssueLinkRequestSchema)) body: IssueLinkRequest,
  ): Promise<IssueLinkResponse> {
    return this.issues.addLink(projectId, issueId, actor, body);
  }

  /** 解除关联（204，先例 minutes/stages DELETE） */
  @Delete(':issueId/links/:linkId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeLink(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Param('issueId', new ZodValidationPipe(z.uuid())) issueId: string,
    @Param('linkId', new ZodValidationPipe(z.uuid())) linkId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<void> {
    return this.issues.removeLink(projectId, issueId, linkId, actor);
  }
}
