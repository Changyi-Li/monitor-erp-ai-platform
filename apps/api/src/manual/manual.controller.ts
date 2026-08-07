import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import {
  ManualAssembleResponseSchema,
  ManualChapterResponseSchema,
  ManualChapterUpdateRequestSchema,
  ManualCreateRequestSchema,
  ManualGenerationDetailResponseSchema,
  ManualGenerationsListResponseSchema,
  type ManualAssembleResponse,
  type ManualChapterResponse,
  type ManualChapterUpdateRequest,
  type ManualCreateRequest,
  type ManualGenerationDetailResponse,
  type ManualGenerationsListResponse,
} from '@monitor/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ManualService } from './manual.service';

const uuidParam = new ZodValidationPipe(z.uuid());

/**
 * 操作手册自动生成（issue #26，spec §6）：嵌套在项目下（数据边界 = 项目）。
 * 查看 = 项目成员；创建/章节生成/审校/组装/发布 = 仅内部（manual:generate，spec §2.4
 * 手册维护仅内部）。项目级权限全部在 service 层按成员表解析（同 blueprints 模式）。
 */
@Controller('projects/:projectId/manuals')
export class ManualController {
  constructor(private readonly manuals: ManualService) {}

  /** 生成会话列表（stale 徽标数据 = 读时计算） */
  @Get()
  @ZodResponse(ManualGenerationsListResponseSchema)
  list(
    @Param('projectId', uuidParam) projectId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<ManualGenerationsListResponse> {
    return this.manuals.listGenerations(projectId, actor);
  }

  /** 创建会话（选蓝图版本 → LLM 章节大纲 → 章节 pending；@Post 默认 201） */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse(ManualGenerationDetailResponseSchema)
  create(
    @Param('projectId', uuidParam) projectId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(ManualCreateRequestSchema)) body: ManualCreateRequest,
  ): Promise<ManualGenerationDetailResponse> {
    return this.manuals.createGeneration(projectId, actor, body);
  }

  /** 会话详情（含章节列表——生成进度/审校/组装页断点续做） */
  @Get(':generationId')
  @ZodResponse(ManualGenerationDetailResponseSchema)
  get(
    @Param('projectId', uuidParam) projectId: string,
    @Param('generationId', uuidParam) generationId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<ManualGenerationDetailResponse> {
    return this.manuals.getGeneration(projectId, generationId, actor);
  }

  /** 单章生成/重生成（覆盖正文回 ready；失败保持原状可重试） */
  @Post(':generationId/chapters/:chapterId/generate')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(ManualChapterResponseSchema)
  generateChapter(
    @Param('projectId', uuidParam) projectId: string,
    @Param('generationId', uuidParam) generationId: string,
    @Param('chapterId', uuidParam) chapterId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<ManualChapterResponse> {
    return this.manuals.generateChapter(projectId, generationId, chapterId, actor);
  }

  /** 章节审校保存（人工修改 → status='edited'） */
  @Put(':generationId/chapters/:chapterId')
  @ZodResponse(ManualChapterResponseSchema)
  updateChapter(
    @Param('projectId', uuidParam) projectId: string,
    @Param('generationId', uuidParam) generationId: string,
    @Param('chapterId', uuidParam) chapterId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(ManualChapterUpdateRequestSchema)) body: ManualChapterUpdateRequest,
  ): Promise<ManualChapterResponse> {
    return this.manuals.updateChapter(projectId, generationId, chapterId, actor, body);
  }

  /** 组装预览（整本 Markdown；发布走 publish 端点） */
  @Post(':generationId/assemble')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(ManualAssembleResponseSchema)
  assemble(
    @Param('projectId', uuidParam) projectId: string,
    @Param('generationId', uuidParam) generationId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<ManualAssembleResponse> {
    return this.manuals.assemble(projectId, generationId, actor);
  }

  /** 发布 → 落项目 kb 草稿（不自动发布 kb 草稿——用户走 kb 发布端点进客户 Index） */
  @Post(':generationId/publish')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(ManualGenerationDetailResponseSchema)
  publish(
    @Param('projectId', uuidParam) projectId: string,
    @Param('generationId', uuidParam) generationId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<ManualGenerationDetailResponse> {
    return this.manuals.publishToKb(projectId, generationId, actor);
  }
}
