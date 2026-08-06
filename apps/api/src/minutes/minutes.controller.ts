import {
  Body,
  Controller,
  Delete,
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
  AttachmentResponseSchema,
  AttachmentUploadSchema,
  MinuteCreateRequestSchema,
  MinuteGetResponseSchema,
  MinuteResponseSchema,
  MinuteUpdateRequestSchema,
  MinutesListResponseSchema,
  type AttachmentResponse,
  type AttachmentUpload,
  type MinuteCreateRequest,
  type MinuteGetResponse,
  type MinuteResponse,
  type MinuteUpdateRequest,
  type MinutesListResponse,
} from '@monitor/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MinutesService } from './minutes.service';

const uuidParam = new ZodValidationPipe(z.uuid());

/** RFC 5987：中文文件名编码（Content-Disposition 不支持裸非 ASCII） */
function dispositionFileName(name: string): string {
  return `inline; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * 会议纪要（issue #18，spec §3.4）：嵌套在项目下（数据边界 = 项目）。
 * 查看 = 项目成员（meeting:view 全员）；创建/编辑/删除/附件管理 = 仅内部（meeting:manage，
 * spec §2.4 会议纪要维护仅内部）。项目级权限全部在 service 层按成员表解析（同 issues 模式）。
 * 下载端点不标 @ZodResponse（返回二进制 Buffer，契约校验不适用）。
 */
@Controller('projects/:projectId/minutes')
export class MinutesController {
  constructor(private readonly minutes: MinutesService) {}

  /** 纪要列表（验收③ 客户可只读查看；会议日期倒序） */
  @Get()
  @ZodResponse(MinutesListResponseSchema)
  list(
    @Param('projectId', uuidParam) projectId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<MinutesListResponse> {
    return this.minutes.listMinutes(projectId, actor);
  }

  /** 创建纪要（验收①：结构化字段 + 富文本正文） */
  @Post()
  @ZodResponse(MinuteResponseSchema)
  create(
    @Param('projectId', uuidParam) projectId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(MinuteCreateRequestSchema)) body: MinuteCreateRequest,
  ): Promise<MinuteResponse> {
    return this.minutes.createMinute(projectId, actor, body);
  }

  /** 纪要详情（附件内联 + 创建人） */
  @Get(':minuteId')
  @ZodResponse(MinuteGetResponseSchema)
  get(
    @Param('projectId', uuidParam) projectId: string,
    @Param('minuteId', uuidParam) minuteId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<MinuteGetResponse> {
    return this.minutes.getMinute(projectId, minuteId, actor);
  }

  /** 编辑纪要（验收①：主题/日期/参会人/正文；null 清空参会人/正文） */
  @Patch(':minuteId')
  @ZodResponse(MinuteResponseSchema)
  update(
    @Param('projectId', uuidParam) projectId: string,
    @Param('minuteId', uuidParam) minuteId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(MinuteUpdateRequestSchema)) body: MinuteUpdateRequest,
  ): Promise<MinuteResponse> {
    return this.minutes.updateMinute(projectId, minuteId, actor, body);
  }

  /** 删除纪要（验收①：附件对象一并清理，附件行级联删） */
  @Delete(':minuteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('projectId', uuidParam) projectId: string,
    @Param('minuteId', uuidParam) minuteId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<void> {
    return this.minutes.deleteMinute(projectId, minuteId, actor);
  }

  /** 上传附件（验收②：JSON + base64 通道，同 drawio；解码后按字节实测 size） */
  @Post(':minuteId/attachments')
  @ZodResponse(AttachmentResponseSchema)
  upload(
    @Param('projectId', uuidParam) projectId: string,
    @Param('minuteId', uuidParam) minuteId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(AttachmentUploadSchema)) body: AttachmentUpload,
  ): Promise<AttachmentResponse> {
    return this.minutes.uploadAttachment(projectId, minuteId, actor, body);
  }

  /** 删除附件（对象存储 + 元信息行） */
  @Delete(':minuteId/attachments/:attachmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeAttachment(
    @Param('projectId', uuidParam) projectId: string,
    @Param('minuteId', uuidParam) minuteId: string,
    @Param('attachmentId', uuidParam) attachmentId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<void> {
    return this.minutes.deleteAttachment(projectId, minuteId, attachmentId, actor);
  }

  /** 附件下载/预览（验收②/③：客户用户可下载；inline = 浏览器可内联预览） */
  @Get(':minuteId/attachments/:attachmentId/file')
  @Header('Cache-Control', 'no-store')
  async getFile(
    @Param('projectId', uuidParam) projectId: string,
    @Param('minuteId', uuidParam) minuteId: string,
    @Param('attachmentId', uuidParam) attachmentId: string,
    @CurrentUser() actor: AuthUser,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<Buffer> {
    const { buffer, name, contentType } = await this.minutes.getAttachmentFile(
      projectId,
      minuteId,
      attachmentId,
      actor,
    );
    res.header('Content-Type', contentType);
    res.header('Content-Disposition', dispositionFileName(name));
    return buffer;
  }
}
