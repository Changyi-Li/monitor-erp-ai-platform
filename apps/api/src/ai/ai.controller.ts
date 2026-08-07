import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  AiConfigResponseSchema,
  AiImageParsingRequestSchema,
  AiImageParsingResponseSchema,
  type AiConfigResponse,
  type AiImageParsingRequest,
  type AiImageParsingResponse,
} from '@monitor/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AiService } from './ai.service';

/**
 * 平台内部 AI 能力（issue #24，spec #80–#82）：内部专属（agent:use 权限域，
 * service 层断言——客户 403 兜底）；非法输入 → 400（body zod 校验 + service 校验）。
 */
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  /** 图片解析（多模态演示：draw.io 蓝图截图/文档截图/附件图片）→ 结构化结果 + 用量 */
  @Post('image-parsing')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(AiImageParsingResponseSchema)
  parseImage(
    @Body(new ZodValidationPipe(AiImageParsingRequestSchema)) body: AiImageParsingRequest,
    @CurrentUser() actor: AuthUser,
  ): Promise<AiImageParsingResponse> {
    this.ai.assertAiUse(actor);
    return this.ai.parseImage(actor, body);
  }

  /** 场景 → 模型映射（web 配置页数据源；换模型 = 改 env 重启后此处随之变化） */
  @Get('config')
  @ZodResponse(AiConfigResponseSchema)
  config(@CurrentUser() actor: AuthUser): Promise<AiConfigResponse> {
    this.ai.assertAiUse(actor);
    return this.ai.getConfig(actor);
  }
}
