import { Controller, Get, Query } from '@nestjs/common';
import {
  UsageSummaryQuerySchema,
  UsageSummaryResponseSchema,
  UsageTrendQuerySchema,
  UsageTrendResponseSchema,
  type UsageSummaryQuery,
  type UsageSummaryResponse,
  type UsageTrendQuery,
  type UsageTrendResponse,
} from '@monitor/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { UsageService } from './usage.service';

/**
 * AI Token 用量统计（issue #23，spec #78）：内部专属（agent:use 权限域，
 * service 层断言——客户 403 兜底）；非法查询枚举 → 400（query zod 校验）。
 */
@Controller('usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  /** 四维分组汇总（客户/项目/场景/模型；客户/项目可选筛选） */
  @Get('summary')
  @ZodResponse(UsageSummaryResponseSchema)
  summary(
    @Query(new ZodValidationPipe(UsageSummaryQuerySchema)) query: UsageSummaryQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<UsageSummaryResponse> {
    this.usage.assertUsageView(actor);
    return this.usage.summary(query, actor);
  }

  /** 时间序列趋势（day/month 桶） */
  @Get('trend')
  @ZodResponse(UsageTrendResponseSchema)
  trend(
    @Query(new ZodValidationPipe(UsageTrendQuerySchema)) query: UsageTrendQuery,
    @CurrentUser() actor: AuthUser,
  ): Promise<UsageTrendResponse> {
    this.usage.assertUsageView(actor);
    return this.usage.trend(query, actor);
  }
}
