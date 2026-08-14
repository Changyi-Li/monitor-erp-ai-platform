import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import {
  type Project,
  type ProjectCreateRequest,
  type ProjectCreateResponse,
  type ProjectGetResponse,
  type ProjectViewerRole,
  type ProjectsListResponse,
} from '@monitor/contracts';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/current-user.decorator';
import { DRIZZLE, type Database } from '../database/database.module';
import { customers, projectMembers, projects, type ProjectRow } from '../database/schema';
import { TenantContextService } from '../database/tenant-context.service';
import { MembersService } from './members.service';

/**
 * 项目查询。
 * 两层边界：租户隔离（RLS 兜底，跨租户 → 404 防探测）+ 项目成员边界
 * （应用层，客户用户只见 active 成员项目；同租户非成员 → 403）。
 * 内部用户全量访问（旁路）。
 */
@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly tenantContext: TenantContextService,
    private readonly members: MembersService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<ProjectsListResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const rows = ctx.isInternal
      ? await this.db.select().from(projects).orderBy(projects.createdAt)
      : await this.listMemberProjects(ctx.userId, ctx.tenantId);
    return { projects: rows.map(toProjectDto) };
  }

  /** 客户用户：active 成员项目（租户过滤 + 成员 ID 交集，双保险） */
  private async listMemberProjects(
    userId: string,
    tenantId: string | null,
  ): Promise<ProjectRow[]> {
    if (!tenantId) {
      return []; // 无租户归属（哨兵）→ 空列表，fail closed
    }
    const memberRows = await this.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(and(eq(projectMembers.userId, userId), eq(projectMembers.isActive, true)));
    if (memberRows.length === 0) {
      return [];
    }
    return this.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.tenantId, tenantId),
          inArray(
            projects.id,
            memberRows.map((r) => r.projectId),
          ),
        ),
      )
      .orderBy(projects.createdAt);
  }

  /**
   * 详情：租户内可见但非成员 → 403（跨项目访问）；跨租户 → 404（防探测）。
   * viewerRole 供前端按角色显隐管理入口。
   */
  async getById(id: string, actor: AuthUser): Promise<ProjectGetResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const row = ctx.isInternal
      ? (await this.db.select().from(projects).where(eq(projects.id, id)).limit(1))[0]
      : (
          await this.db
            .select()
            .from(projects)
            .where(and(eq(projects.id, id), eq(projects.tenantId, ctx.tenantId!)))
            .limit(1)
        )[0];
    if (!row) {
      throw new NotFoundException('项目不存在');
    }

    let viewerRole: ProjectViewerRole = 'internal';
    if (!ctx.isInternal) {
      const role = await this.members.resolveViewerRole(id, ctx.userId);
      if (!role) {
        throw new ForbiddenException('你不是该项目成员');
      }
      viewerRole = role;
    }

    await this.audit.record(AUDIT_ACTIONS.PROJECT_READ, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'project',
      resourceId: row.id,
    });
    return { project: toProjectDto(row), viewerRole };
  }

  /** 创建项目并归属客户（内部/超管专属，@Roles 守卫在 controller） */
  async create(
    actor: AuthUser,
    input: ProjectCreateRequest,
  ): Promise<ProjectCreateResponse> {
    // 客户存在性前置检查（FK 违反会 500，这里给 404；内部旁路策略可见全部客户）
    const [customer] = await this.db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, input.tenantId))
      .limit(1);
    if (!customer) {
      throw new NotFoundException('客户不存在');
    }
    const [row] = await this.db
      .insert(projects)
      .values({
        tenantId: input.tenantId,
        name: input.name,
        description: input.description ?? null,
      })
      .returning();
    if (!row) {
      throw new InternalServerErrorException('创建项目失败');
    }
    await this.audit.record(AUDIT_ACTIONS.PROJECT_CREATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'project',
      resourceId: row.id,
      metadata: { tenantId: row.tenantId, name: row.name },
    });
    return { project: toProjectDto(row) };
  }
}

/** DB 行 → 契约 Project：Date 必须 toISOString()（z.iso.datetime() 要求） */
function toProjectDto(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    tenantId: row.tenantId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
