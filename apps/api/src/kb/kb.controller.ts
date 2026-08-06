import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  KbContentResponseSchema,
  KbCreateRequestSchema,
  KbDocumentResponseSchema,
  KbListResponseSchema,
  KbUpdateRequestSchema,
  KbVersionsResponseSchema,
  type KbContentResponse,
  type KbCreateRequest,
  type KbDocumentResponse,
  type KbListResponse,
  type KbUpdateRequest,
  type KbVersionsResponse,
} from '@monitor/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { KbService } from './kb.service';

const uuidParam = new ZodValidationPipe(z.uuid());

/** RFC 5987：中文文件名编码（Content-Disposition 不支持裸非 ASCII） */
function dispositionFileName(name: string): string {
  return `inline; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * 内部知识库（issue #19，spec §4.1/§4.3）：**全局路由**（无项目前缀——内部知识库不挂
 * 客户/项目，客户知识库 = 内部 KB + 本项目文档是逻辑视图）。维护 = 仅内部
 * （kb:edit，spec §2.4）；查看默认开放（无 kb:view）：客户用户只读已发布文档。
 * 下载端点不标 @ZodResponse（返回二进制 Buffer，契约校验不适用）。
 */
@Controller('kb/documents')
export class KbController {
  constructor(private readonly kb: KbService) {}

  /** 文档列表（分类筛选；客户仅已发布；内部默认不含归档，includeArchived 管理视图） */
  @Get()
  @ZodResponse(KbListResponseSchema)
  list(
    @Query('category') category: string | undefined,
    @Query('includeArchived') includeArchived: string | undefined,
    @CurrentUser() actor: AuthUser,
  ): Promise<KbListResponse> {
    return this.kb.listDocuments(actor, {
      category,
      includeArchived: includeArchived === 'true',
    });
  }

  /** 创建文档（草稿态；markdown 或文件 JSON+base64 通道，同 drawio/minutes） */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse(KbDocumentResponseSchema)
  create(
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(KbCreateRequestSchema)) body: KbCreateRequest,
  ): Promise<KbDocumentResponse> {
    return this.kb.createDocument(actor, body);
  }

  /** 文档详情（markdown 内联正文 / 文件元信息 + hasDraft + viewerRole） */
  @Get(':documentId')
  @ZodResponse(KbDocumentResponseSchema)
  get(
    @Param('documentId', uuidParam) documentId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<KbDocumentResponse> {
    return this.kb.getDocument(documentId, actor);
  }

  /** 保存草稿（markdown 改正文/标题/分类；文件类覆盖上传；编辑已发布 → 派生新草稿版本） */
  @Patch(':documentId')
  @ZodResponse(KbDocumentResponseSchema)
  update(
    @Param('documentId', uuidParam) documentId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(KbUpdateRequestSchema)) body: KbUpdateRequest,
  ): Promise<KbDocumentResponse> {
    return this.kb.updateDocument(documentId, actor, body);
  }

  /** 发布/重新发布（草稿版本转正；发布动作是 RAG 同步触发点——切片 11/#21 接入） */
  @Post(':documentId/publish')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(KbDocumentResponseSchema)
  publish(
    @Param('documentId', uuidParam) documentId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<KbDocumentResponse> {
    return this.kb.publishDocument(documentId, actor);
  }

  /** 归档（仅已发布；「归档即下架」，列表默认消失） */
  @Post(':documentId/archive')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(KbDocumentResponseSchema)
  archive(
    @Param('documentId', uuidParam) documentId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<KbDocumentResponse> {
    return this.kb.archiveDocument(documentId, actor);
  }

  /** 恢复（已归档 → 重新上架，线上内容 = 最后发布版本） */
  @Post(':documentId/restore')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(KbDocumentResponseSchema)
  restore(
    @Param('documentId', uuidParam) documentId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<KbDocumentResponse> {
    return this.kb.restoreDocument(documentId, actor);
  }

  /** 版本历史（内部端点）：发布版本 + 当前草稿 */
  @Get(':documentId/versions')
  @ZodResponse(KbVersionsResponseSchema)
  versions(
    @Param('documentId', uuidParam) documentId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<KbVersionsResponse> {
    return this.kb.listVersions(documentId, actor);
  }

  /** 版本内容回看（内部）：markdown → {body}；文件 → 二进制下载（不标 @ZodResponse——双形态响应） */
  @Get(':documentId/versions/:versionId/content')
  @Header('Cache-Control', 'no-store')
  async versionContent(
    @Param('documentId', uuidParam) documentId: string,
    @Param('versionId', uuidParam) versionId: string,
    @CurrentUser() actor: AuthUser,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<unknown> {
    const result = await this.kb.getVersionContent(documentId, versionId, actor);
    if (result.kind === 'markdown') {
      return { body: result.body };
    }
    res.header('Content-Type', result.contentType);
    res.header('Content-Disposition', dispositionFileName(result.name));
    return result.buffer;
  }

  /** 文件类当前线上内容下载（客户 = 已发布文档；inline = 浏览器可内联预览） */
  @Get(':documentId/content')
  @Header('Cache-Control', 'no-store')
  async fileContent(
    @Param('documentId', uuidParam) documentId: string,
    @CurrentUser() actor: AuthUser,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<Buffer> {
    const { buffer, name, contentType } = await this.kb.getDocumentContent(documentId, actor);
    res.header('Content-Type', contentType);
    res.header('Content-Disposition', dispositionFileName(name));
    return buffer;
  }
}
