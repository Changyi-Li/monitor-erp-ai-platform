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
  Put,
} from '@nestjs/common';
import { z } from 'zod';
import {
  RiskCreateRequestSchema,
  RiskOwnersListResponseSchema,
  RiskResponseSchema,
  RiskUpdateRequestSchema,
  RisksListResponseSchema,
  StageCreateRequestSchema,
  StageReorderRequestSchema,
  StageResponseSchema,
  StageTemplatesResponseSchema,
  StageUpdateRequestSchema,
  StagesListResponseSchema,
  type RiskCreateRequest,
  type RiskOwnersListResponse,
  type RiskResponse,
  type RiskUpdateRequest,
  type RisksListResponse,
  type StageCreateRequest,
  type StageReorderRequest,
  type StageResponse,
  type StageTemplatesResponse,
  type StageUpdateRequest,
  type StagesListResponse,
} from '@monitor/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { StagesService } from './stages.service';

const uuidParam = new ZodValidationPipe(z.uuid());

/**
 * 实施阶段（issue #17，spec §3.3）：嵌套在项目下（数据边界 = 项目）。
 * 查看 = 项目成员（phase:view 全员，§2.4 line 77）；创建/编辑/删除/排序/流转 = 仅内部
 * （phase:manage，line 81）。项目级权限全部在 service 层按成员表解析（同 issues 模式）。
 */
@Controller('projects/:projectId/stages')
export class StagesController {
  constructor(private readonly stages: StagesService) {}

  /** 阶段列表（看板泳道数据源；sortOrder 升序） */
  @Get()
  @ZodResponse(StagesListResponseSchema)
  list(
    @Param('projectId', uuidParam) projectId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<StagesListResponse> {
    return this.stages.listStages(projectId, actor);
  }

  /** 标准阶段模板（Phase 1 内置常量；建阶段时选来源） */
  @Get('templates')
  @ZodResponse(StageTemplatesResponseSchema)
  templates(
    @Param('projectId', uuidParam) projectId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<StageTemplatesResponse> {
    return this.stages.listTemplates(projectId, actor);
  }

  /** 创建阶段（验收①：基于模板实例化；sortOrder 追加到末尾） */
  @Post()
  @ZodResponse(StageResponseSchema)
  create(
    @Param('projectId', uuidParam) projectId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(StageCreateRequestSchema)) body: StageCreateRequest,
  ): Promise<StageResponse> {
    return this.stages.createStage(projectId, actor, body);
  }

  /** 编辑阶段（名称/描述；status 自由流转——未开始/进行中/已完成/已暂停） */
  @Patch(':stageId')
  @ZodResponse(StageResponseSchema)
  update(
    @Param('projectId', uuidParam) projectId: string,
    @Param('stageId', uuidParam) stageId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(StageUpdateRequestSchema)) body: StageUpdateRequest,
  ): Promise<StageResponse> {
    return this.stages.updateStage(projectId, stageId, actor, body);
  }

  /** 删除阶段（关联风险 FK set null 保留） */
  @Delete(':stageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('projectId', uuidParam) projectId: string,
    @Param('stageId', uuidParam) stageId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<void> {
    return this.stages.deleteStage(projectId, stageId, actor);
  }

  /** 排序调整（验收①：全量目标顺序；PUT 全量替换语义） */
  @Put('reorder')
  @ZodResponse(StagesListResponseSchema)
  reorder(
    @Param('projectId', uuidParam) projectId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(StageReorderRequestSchema)) body: StageReorderRequest,
  ): Promise<StagesListResponse> {
    return this.stages.reorderStages(projectId, actor, body);
  }
}

/**
 * 风险点（issue #17，spec §3.3）：项目级，可关联具体阶段；等级 高/中/低。
 * 查看 = 项目成员（phase:view，同阶段域）；创建/编辑/删除 = 仅内部（risk:manage）。
 */
@Controller('projects/:projectId/risks')
export class RisksController {
  constructor(private readonly stages: StagesService) {}

  /** 风险列表（join 阶段名/负责人名；验收③ 客户可只读查看） */
  @Get()
  @ZodResponse(RisksListResponseSchema)
  list(
    @Param('projectId', uuidParam) projectId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<RisksListResponse> {
    return this.stages.listRisks(projectId, actor);
  }

  /** 创建风险（验收②：描述 + 等级 + 可选关联阶段/负责人） */
  @Post()
  @ZodResponse(RiskResponseSchema)
  create(
    @Param('projectId', uuidParam) projectId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(RiskCreateRequestSchema)) body: RiskCreateRequest,
  ): Promise<RiskResponse> {
    return this.stages.createRisk(projectId, actor, body);
  }

  /** 更新风险（等级/状态/关联阶段/负责人；null 清空关联） */
  @Patch(':riskId')
  @ZodResponse(RiskResponseSchema)
  update(
    @Param('projectId', uuidParam) projectId: string,
    @Param('riskId', uuidParam) riskId: string,
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(RiskUpdateRequestSchema)) body: RiskUpdateRequest,
  ): Promise<RiskResponse> {
    return this.stages.updateRisk(projectId, riskId, actor, body);
  }

  /** 删除风险 */
  @Delete(':riskId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('projectId', uuidParam) projectId: string,
    @Param('riskId', uuidParam) riskId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<void> {
    return this.stages.deleteRisk(projectId, riskId, actor);
  }

  /** 负责人候选（内部/超管 active 用户） */
  @Get('assignees')
  @ZodResponse(RiskOwnersListResponseSchema)
  assignees(
    @Param('projectId', uuidParam) projectId: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<RiskOwnersListResponse> {
    return this.stages.listRiskOwners(projectId, actor);
  }
}
