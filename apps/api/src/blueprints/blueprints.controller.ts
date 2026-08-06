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
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  BlueprintCreateRequestSchema,
  BlueprintGetResponseSchema,
  BlueprintPublishResponseSchema,
  BlueprintUpdateRequestSchema,
  BlueprintUpdateResponseSchema,
  BlueprintVersionGetResponseSchema,
  BlueprintVersionsListResponseSchema,
  type BlueprintCreateRequest,
  type BlueprintGetResponse,
  type BlueprintPublishResponse,
  type BlueprintUpdateRequest,
  type BlueprintUpdateResponse,
  type BlueprintVersionGetResponse,
  type BlueprintVersionsListResponse,
} from '@monitor/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { BlueprintsService } from './blueprints.service';

/** 路径版本号：coerce 数字（'2' → 2），非法 → 400 */
const versionParam = new ZodValidationPipe(z.coerce.number().int().positive());

/** RFC 5987：中文文件名编码（Content-Disposition 不支持裸非 ASCII） */
function dispositionFileName(name: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * 蓝图（issue #16）：嵌套在项目下（数据边界 = 项目）。
 * 查看 = 项目成员（blueprint:view 全员）；创建/编辑/发布 = 仅内部（blueprint:manage，
 * spec §2.4 蓝图维护仅内部）。项目级权限全部在 service 层按成员表解析（同 issues 模式）。
 * 下载端点不标 @ZodResponse（返回二进制 Buffer，契约校验不适用）。
 */
@Controller('projects/:projectId/blueprints')
export class BlueprintsController {
  constructor(private readonly blueprints: BlueprintsService) {}

  @Get()
  @ZodResponse(BlueprintGetResponseSchema)
  get(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<BlueprintGetResponse> {
    return this.blueprints.get(projectId, actor);
  }

  /** 首次创建（验收①：上传 + 结构化内容 → 自动发布 v1 快照）；已存在 → 409 */
  @Post()
  @ZodResponse(BlueprintPublishResponseSchema)
  create(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(BlueprintCreateRequestSchema)) body: BlueprintCreateRequest,
  ): Promise<BlueprintPublishResponse> {
    return this.blueprints.create(projectId, actor, body);
  }

  /** 编辑当前内容（PATCH 后须显式发布才生成新版本） */
  @Patch()
  @ZodResponse(BlueprintUpdateResponseSchema)
  update(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(BlueprintUpdateRequestSchema)) body: BlueprintUpdateRequest,
  ): Promise<BlueprintUpdateResponse> {
    return this.blueprints.update(projectId, actor, body);
  }

  /** 发布新版本（验收②：编辑 → 发布 → 版本历史 v1/v2…；@Post 默认 201 语义不符 → 200） */
  @Post('publish')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(BlueprintPublishResponseSchema)
  publish(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<BlueprintPublishResponse> {
    return this.blueprints.publish(projectId, actor);
  }

  /** 版本历史（v1/v2… 升序，含发布人与发布时间） */
  @Get('versions')
  @ZodResponse(BlueprintVersionsListResponseSchema)
  listVersions(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<BlueprintVersionsListResponse> {
    return this.blueprints.listVersions(projectId, actor);
  }

  /** 历史版本回看（快照不可变） */
  @Get('versions/:version')
  @ZodResponse(BlueprintVersionGetResponseSchema)
  getVersion(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Param('version', versionParam) version: number,
    @CurrentUser() actor: AuthUser,
  ): Promise<BlueprintVersionGetResponse> {
    return this.blueprints.getVersion(projectId, version, actor);
  }

  /** 下载原文件（验收③：可下载；字节流 + Content-Disposition 带原文件名） */
  @Get('versions/:version/file')
  @Header('Cache-Control', 'no-store')
  async getFile(
    @Param('projectId', new ZodValidationPipe(z.uuid())) projectId: string,
    @Param('version', versionParam) version: number,
    @CurrentUser() actor: AuthUser,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<Buffer> {
    const { buffer, name, contentType } = await this.blueprints.getVersionFile(
      projectId,
      version,
      actor,
    );
    res.header('Content-Type', contentType);
    res.header('Content-Disposition', dispositionFileName(name));
    return buffer;
  }
}
