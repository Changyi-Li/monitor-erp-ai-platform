import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, max } from 'drizzle-orm';
import {
  type ProjectViewerRole,
  type Risk,
  type RiskCreateRequest,
  type RiskOwnersListResponse,
  type RiskResponse,
  type RisksListResponse,
  type RiskUpdateRequest,
  type Stage,
  type StageCreateRequest,
  type StageReorderRequest,
  type StageResponse,
  type StageTemplatesResponse,
  type StageUpdateRequest,
  type StagesListResponse,
} from '@monitor/contracts';
import { can, STAGE_TEMPLATES } from '@monitor/shared';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/current-user.decorator';
import { DRIZZLE, type Database } from '../database/database.module';
import {
  projectRisks,
  projectStages,
  projects,
  users,
  type ProjectRiskRow,
  type ProjectStageRow,
} from '../database/schema';
import { TenantContextService, type TenantContext } from '../database/tenant-context.service';
import { MembersService } from '../projects/members.service';

/**
 * 实施阶段与风险（issue #17，spec §3.3，数据边界 = 项目）。
 * 两层边界（与 issues/blueprints 同构）：租户 RLS 兜底（跨租户 → 404 防探测）+
 * 应用层项目成员校验（同租户非成员 → 403）。项目级权限全部在 service 层按成员表解析：
 * 查看=全员（phase:view，spec §2.4 line 77）、阶段/风险管理=仅内部（phase:manage/risk:manage，
 * line 81）。阶段状态自由流转（无 issues 式严格状态机）。
 */
@Injectable()
export class StagesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly tenantContext: TenantContextService,
    private readonly members: MembersService,
    private readonly audit: AuditService,
  ) {}

  /** 项目准入：内部 → 'internal'；客户用户须为该项目 active 成员（非成员 → 403） */
  private async resolveViewerRole(
    projectId: string,
    ctx: TenantContext,
  ): Promise<ProjectViewerRole> {
    if (ctx.isInternal) {
      return 'internal';
    }
    const role = await this.members.resolveViewerRole(projectId, ctx.userId);
    if (!role) {
      throw new ForbiddenException('你不是该项目成员');
    }
    return role;
  }

  /** 项目存在性（RLS 过滤：客户用户跨租户项目 → 404 防探测） */
  private async requireProject(projectId: string): Promise<{ id: string; tenantId: string }> {
    const [project] = await this.db
      .select({ id: projects.id, tenantId: projects.tenantId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) {
      throw new NotFoundException('项目不存在');
    }
    return project;
  }

  /** 阶段行（RLS + 路径 projectId 双重匹配，跨项目/跨租户 → 404） */
  private async requireStage(projectId: string, stageId: string): Promise<ProjectStageRow> {
    const [row] = await this.db
      .select()
      .from(projectStages)
      .where(and(eq(projectStages.id, stageId), eq(projectStages.projectId, projectId)))
      .limit(1);
    if (!row) {
      throw new NotFoundException('阶段不存在');
    }
    return row;
  }

  /** 风险行（RLS + 路径 projectId 双重匹配，跨项目/跨租户 → 404） */
  private async requireRisk(projectId: string, riskId: string): Promise<ProjectRiskRow> {
    const [row] = await this.db
      .select()
      .from(projectRisks)
      .where(and(eq(projectRisks.id, riskId), eq(projectRisks.projectId, projectId)))
      .limit(1);
    if (!row) {
      throw new NotFoundException('风险不存在');
    }
    return row;
  }

  /** 角色级权限检查（viewerRole 为 null 时 fail closed） */
  private assertPermission(
    viewerRole: ProjectViewerRole,
    permission: 'phase:view' | 'phase:manage' | 'risk:manage',
    message: string,
  ): void {
    if (!can(viewerRole, permission)) {
      throw new ForbiddenException(message);
    }
  }

  /** 内部/超管 active 用户校验（负责人；非内部 → 400） */
  private async requireInternalUser(userId: string, message: string): Promise<void> {
    const [user] = await this.db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.isActive, true)))
      .limit(1);
    if (!user || !['super_admin', 'internal'].includes(user.role)) {
      throw new BadRequestException(message);
    }
  }

  // ---- 模板（标准阶段模板 = Phase 1 内置常量，只读） ----

  /** 模板列表（项目成员可读；前端建阶段时选择来源） */
  async listTemplates(projectId: string, actor: AuthUser): Promise<StageTemplatesResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'phase:view', '你不是该项目成员');
    return { templates: STAGE_TEMPLATES.map((t) => ({ key: t.key, name: t.name, description: t.description })) };
  }

  // ---- 阶段 ----

  /** 列表（spec §3.3；sortOrder 升序，看板泳道按状态分组时列内顺序一致） */
  async listStages(projectId: string, actor: AuthUser): Promise<StagesListResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'phase:view', '你不是该项目成员');

    const rows = await this.db
      .select()
      .from(projectStages)
      .where(eq(projectStages.projectId, projectId))
      .orderBy(projectStages.sortOrder);
    return { stages: rows.map(toStageDto), viewerRole };
  }

  /** 创建阶段（基于模板实例化；sortOrder = 项目内当前最大 + 1） */
  async createStage(
    projectId: string,
    actor: AuthUser,
    input: StageCreateRequest,
  ): Promise<StageResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const project = await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'phase:manage', '仅内部用户可管理实施阶段');

    const [maxRow] = await this.db
      .select({ v: max(projectStages.sortOrder) })
      .from(projectStages)
      .where(eq(projectStages.projectId, projectId));
    const [row] = await this.db
      .insert(projectStages)
      .values({
        tenantId: project.tenantId,
        projectId,
        templateKey: input.templateKey ?? null,
        name: input.name,
        description: input.description ?? null,
        sortOrder: (maxRow?.v ?? -1) + 1,
      })
      .returning();
    if (!row) {
      throw new InternalServerErrorException('创建阶段失败');
    }
    await this.audit.record(AUDIT_ACTIONS.STAGE_CREATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'project_stage',
      resourceId: row.id,
      metadata: { projectId, name: row.name, templateKey: row.templateKey },
    });
    return { stage: toStageDto(row) };
  }

  /** 编辑阶段（部分更新：undefined 不动、null 清空 description；status 自由流转；空对象=无操作） */
  async updateStage(
    projectId: string,
    stageId: string,
    actor: AuthUser,
    input: StageUpdateRequest,
  ): Promise<StageResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'phase:manage', '仅内部用户可管理实施阶段');

    const stage = await this.requireStage(projectId, stageId);
    if (input.name === undefined && input.description === undefined && input.status === undefined) {
      return { stage: toStageDto(stage) }; // 空对象 = 无操作（set({}) 会生成非法 SQL）
    }
    const [row] = await this.db
      .update(projectStages)
      .set({
        name: input.name,
        description: input.description,
        status: input.status,
        updatedAt: new Date(),
      })
      .where(and(eq(projectStages.id, stage.id), eq(projectStages.projectId, projectId)))
      .returning();
    if (!row) {
      throw new NotFoundException('阶段不存在');
    }
    await this.audit.record(AUDIT_ACTIONS.STAGE_UPDATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'project_stage',
      resourceId: row.id,
      metadata: { projectId, name: row.name, status: row.status },
    });
    return { stage: toStageDto(row) };
  }

  /** 删除阶段（验收① 增删；关联风险 stageId 由 FK set null 保留） */
  async deleteStage(projectId: string, stageId: string, actor: AuthUser): Promise<void> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'phase:manage', '仅内部用户可管理实施阶段');

    const stage = await this.requireStage(projectId, stageId);
    const [deleted] = await this.db
      .delete(projectStages)
      .where(and(eq(projectStages.id, stage.id), eq(projectStages.projectId, projectId)))
      .returning({ id: projectStages.id });
    if (!deleted) {
      throw new NotFoundException('阶段不存在');
    }
    await this.audit.record(AUDIT_ACTIONS.STAGE_DELETE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'project_stage',
      resourceId: stage.id,
      metadata: { projectId, name: stage.name },
    });
  }

  /** 排序调整（验收①：全量目标顺序，按索引重写 sortOrder；含无效/跨项目 id → 400） */
  async reorderStages(
    projectId: string,
    actor: AuthUser,
    input: StageReorderRequest,
  ): Promise<StagesListResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'phase:manage', '仅内部用户可管理实施阶段');

    const found = await this.db
      .select({ id: projectStages.id })
      .from(projectStages)
      .where(
        and(eq(projectStages.projectId, projectId), inArray(projectStages.id, input.stageIds)),
      );
    if (found.length !== input.stageIds.length) {
      throw new BadRequestException('排序列表包含不存在或跨项目的阶段');
    }
    for (const [index, stageId] of input.stageIds.entries()) {
      await this.db
        .update(projectStages)
        .set({ sortOrder: index, updatedAt: new Date() })
        .where(eq(projectStages.id, stageId));
    }
    await this.audit.record(AUDIT_ACTIONS.STAGE_REORDER, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'project_stage',
      metadata: { projectId, count: input.stageIds.length, stageIds: input.stageIds },
    });
    const rows = await this.db
      .select()
      .from(projectStages)
      .where(eq(projectStages.projectId, projectId))
      .orderBy(projectStages.sortOrder);
    return { stages: rows.map(toStageDto), viewerRole };
  }

  // ---- 风险 ----

  /** 风险列表（spec §3.3；join 阶段名/负责人名；最新在前；查看=全员 phase:view） */
  async listRisks(projectId: string, actor: AuthUser): Promise<RisksListResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'phase:view', '你不是该项目成员');

    const rows = await this.db
      .select({
        risk: projectRisks,
        stageName: projectStages.name,
        ownerName: users.displayName,
      })
      .from(projectRisks)
      .leftJoin(projectStages, eq(projectStages.id, projectRisks.stageId))
      .leftJoin(users, eq(users.id, projectRisks.ownerId))
      .where(eq(projectRisks.projectId, projectId))
      .orderBy(projectRisks.createdAt);
    return { risks: rows.map((r) => toRiskDto(r.risk, r.stageName, r.ownerName)), viewerRole };
  }

  /** 创建风险（等级必填；可关联阶段 + 内部负责人；stageId/ownerId 均须属于本项目/内部） */
  async createRisk(
    projectId: string,
    actor: AuthUser,
    input: RiskCreateRequest,
  ): Promise<RiskResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const project = await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'risk:manage', '仅内部用户可管理风险');

    if (input.stageId !== undefined && input.stageId !== null) {
      await this.requireStageInProject(projectId, input.stageId);
    }
    if (input.ownerId !== undefined && input.ownerId !== null) {
      await this.requireInternalUser(input.ownerId, '风险负责人必须是内部用户');
    }

    const [row] = await this.db
      .insert(projectRisks)
      .values({
        tenantId: project.tenantId,
        projectId,
        stageId: input.stageId ?? null,
        description: input.description,
        level: input.level,
        status: input.status ?? 'open',
        ownerId: input.ownerId ?? null,
      })
      .returning();
    if (!row) {
      throw new InternalServerErrorException('创建风险失败');
    }
    const joined = await this.riskWithNames(row.id);
    await this.audit.record(AUDIT_ACTIONS.RISK_CREATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'project_risk',
      resourceId: row.id,
      metadata: { projectId, level: row.level, status: row.status, stageId: row.stageId },
    });
    return { risk: joined };
  }

  /** 更新风险（部分更新：undefined 不动、null 清空 stageId/ownerId；空对象=无操作） */
  async updateRisk(
    projectId: string,
    riskId: string,
    actor: AuthUser,
    input: RiskUpdateRequest,
  ): Promise<RiskResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'risk:manage', '仅内部用户可管理风险');

    const risk = await this.requireRisk(projectId, riskId);
    if (
      input.description === undefined &&
      input.level === undefined &&
      input.status === undefined &&
      input.stageId === undefined &&
      input.ownerId === undefined
    ) {
      return { risk: await this.riskWithNames(risk.id) }; // 空对象 = 无操作
    }
    if (input.stageId !== undefined && input.stageId !== null) {
      await this.requireStageInProject(projectId, input.stageId);
    }
    if (input.ownerId !== undefined && input.ownerId !== null) {
      await this.requireInternalUser(input.ownerId, '风险负责人必须是内部用户');
    }
    const [row] = await this.db
      .update(projectRisks)
      .set({
        description: input.description,
        level: input.level,
        status: input.status,
        stageId: input.stageId,
        ownerId: input.ownerId,
        updatedAt: new Date(),
      })
      .where(and(eq(projectRisks.id, risk.id), eq(projectRisks.projectId, projectId)))
      .returning();
    if (!row) {
      throw new NotFoundException('风险不存在');
    }
    await this.audit.record(AUDIT_ACTIONS.RISK_UPDATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'project_risk',
      resourceId: row.id,
      metadata: { projectId, level: row.level, status: row.status, stageId: row.stageId, ownerId: row.ownerId },
    });
    return { risk: await this.riskWithNames(row.id) };
  }

  /** 删除风险 */
  async deleteRisk(projectId: string, riskId: string, actor: AuthUser): Promise<void> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'risk:manage', '仅内部用户可管理风险');

    const risk = await this.requireRisk(projectId, riskId);
    const [deleted] = await this.db
      .delete(projectRisks)
      .where(and(eq(projectRisks.id, risk.id), eq(projectRisks.projectId, projectId)))
      .returning({ id: projectRisks.id });
    if (!deleted) {
      throw new NotFoundException('风险不存在');
    }
    await this.audit.record(AUDIT_ACTIONS.RISK_DELETE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'project_risk',
      resourceId: risk.id,
      metadata: { projectId, description: risk.description, level: risk.level },
    });
  }

  /** 风险负责人候选（内部/超管 active 用户；仅内部可管理风险 → 内部可见） */
  async listRiskOwners(projectId: string, actor: AuthUser): Promise<RiskOwnersListResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertPermission(viewerRole, 'risk:manage', '仅内部用户可查看风险负责人候选');

    const rows = await this.db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(and(eq(users.isActive, true), inArray(users.role, ['super_admin', 'internal'])))
      .orderBy(users.displayName);
    return { assignees: rows };
  }

  /** 关联阶段必须属于本项目（防跨项目关联） */
  private async requireStageInProject(projectId: string, stageId: string): Promise<void> {
    const [stage] = await this.db
      .select({ id: projectStages.id })
      .from(projectStages)
      .where(and(eq(projectStages.id, stageId), eq(projectStages.projectId, projectId)))
      .limit(1);
    if (!stage) {
      throw new BadRequestException('关联阶段不存在或不属于该项目');
    }
  }

  /** 风险行 + join 阶段名/负责人名 */
  private async riskWithNames(
    riskId: string,
  ): Promise<Risk> {
    const [row] = await this.db
      .select({
        risk: projectRisks,
        stageName: projectStages.name,
        ownerName: users.displayName,
      })
      .from(projectRisks)
      .leftJoin(projectStages, eq(projectStages.id, projectRisks.stageId))
      .leftJoin(users, eq(users.id, projectRisks.ownerId))
      .where(eq(projectRisks.id, riskId))
      .limit(1);
    if (!row) {
      throw new NotFoundException('风险不存在');
    }
    return toRiskDto(row.risk, row.stageName, row.ownerName);
  }
}

/** DB 行 → 契约 Stage：Date 必须 toISOString()（z.iso.datetime() 要求） */
function toStageDto(row: ProjectStageRow): Stage {
  return {
    id: row.id,
    projectId: row.projectId,
    templateKey: row.templateKey ?? null,
    name: row.name,
    description: row.description ?? null,
    status: row.status as Stage['status'],
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 风险行 → 契约 Risk（join 出的名称 nullable——阶段/负责人删除后 set null） */
function toRiskDto(
  row: ProjectRiskRow,
  stageName: string | null,
  ownerName: string | null,
): Risk {
  return {
    id: row.id,
    projectId: row.projectId,
    stageId: row.stageId ?? null,
    stageName,
    description: row.description,
    level: row.level as Risk['level'],
    status: row.status as Risk['status'],
    ownerId: row.ownerId ?? null,
    ownerName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
