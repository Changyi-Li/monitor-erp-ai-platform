import { Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  RagFailNextResponseSchema,
  RagIndexResponseSchema,
  RagSyncsQuerySchema,
  RagSyncsResponseSchema,
  type RagFailNextResponse,
  type RagIndexResponse,
  type RagSyncsQuery,
  type RagSyncsResponse,
} from '@monitor/contracts';
import { RAG_SCOPES } from '@monitor/shared';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RagSyncService } from './rag-sync.service';

/**
 * RAG 同步状态/调试台（issue #21）：全局端点（无项目上下文），
 * 权限 = rag:view（仅内部，spec 用户故事 50；service 层按 JWT 角色断言）。
 * fake Index 仅内存（进程内），真实 RAG 平台接入后由平台持久化。
 */
@Controller('rag')
export class RagSyncController {
  constructor(private readonly syncs: RagSyncService) {}

  /** 同步任务面板（状态流转 queued→processing→succeeded/failed、attempt、错误） */
  @Get('syncs')
  @ZodResponse(RagSyncsResponseSchema)
  listSyncs(
    @CurrentUser() actor: AuthUser,
    @Query(new ZodValidationPipe(RagSyncsQuerySchema)) query: RagSyncsQuery,
  ): Promise<RagSyncsResponse> {
    this.syncs.assertRagView(actor);
    return this.syncs.listSyncs(query);
  }

  /** fake Index 可见文档（scope 路由验证：内部/客户各归其位） */
  @Get('index')
  @ZodResponse(RagIndexResponseSchema)
  listIndex(
    @CurrentUser() actor: AuthUser,
    @Query('scope', new ZodValidationPipe(z.enum(RAG_SCOPES))) scope: 'internal' | 'customer',
  ): Promise<RagIndexResponse> {
    this.syncs.assertRagView(actor);
    return this.syncs.listIndex(scope);
  }

  /** 调试注入：「下一次同步导入抛错」→ 演示失败 → 指数退避重试（仅 memory 驱动） */
  @Post('debug/fail-next')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(RagFailNextResponseSchema)
  failNext(@CurrentUser() actor: AuthUser): Promise<RagFailNextResponse> {
    this.syncs.assertRagView(actor);
    return this.syncs.failNext();
  }
}
