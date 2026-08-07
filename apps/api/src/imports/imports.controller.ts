import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import {
  ImportFetchRunResponseSchema,
  ImportPushRequestSchema,
  ImportPushResponseSchema,
  ImportStagedListResponseSchema,
  type ImportFetchRunResponse,
  type ImportPushRequest,
  type ImportPushResponse,
  type ImportStagedListResponse,
} from '@monitor/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { Public } from '../common/public.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ImportAuthGuard } from './import-auth.guard';
import { ImportsService } from './imports.service';

/**
 * Online help 导入通道（issue #25，spec §4.4）：
 * - POST /imports/documents：@Public + ImportAuthGuard 双通道认证（x-api-key 外部推送 /
 *   Bearer JWT 调试页）→ 幂等暂存（指纹去重）；
 * - GET /imports/staged：调试页暂存记录（普通 JWT + service kb:edit 断言，仅内部）；
 * - POST /imports/fetch/run：手动触发一次定时拉取（demo/调试；定时器路径同 service）。
 */
@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  /** 导入 API：外部项目推送（upsert 新文档/变更 / delete 移除） */
  @Post('documents')
  @Public()
  @UseGuards(ImportAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse(ImportPushResponseSchema)
  push(
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(ImportPushRequestSchema)) body: ImportPushRequest,
  ): Promise<ImportPushResponse> {
    return this.imports.push(actor, body);
  }

  /** 暂存记录列表（status/source 筛选；query 字符串手动过滤，同 kb/rag controller 惯例） */
  @Get('staged')
  @ZodResponse(ImportStagedListResponseSchema)
  list(
    @CurrentUser() actor: AuthUser,
    @Query('status') status: string | undefined,
    @Query('source') source: string | undefined,
  ): Promise<ImportStagedListResponse> {
    return this.imports.listStaged(actor, {
      status: status as 'pending' | 'processing' | 'processed' | 'failed' | undefined,
      source: source as 'api' | 'fetch' | undefined,
    });
  }

  /** 手动触发一次定时拉取（立即拉取外部源清单 → 增量暂存 + 删除派生） */
  @Post('fetch/run')
  @Public()
  @UseGuards(ImportAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ZodResponse(ImportFetchRunResponseSchema)
  fetchRun(@CurrentUser() actor: AuthUser): Promise<ImportFetchRunResponse> {
    return this.imports.runFetch(actor);
  }
}
