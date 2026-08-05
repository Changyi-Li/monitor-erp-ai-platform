import { Inject, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  type Project,
  type ProjectGetResponse,
  type ProjectsListResponse,
} from '@monitor/contracts';
import { DRIZZLE, type Database } from '../database/database.module';
import { projects, type ProjectRow } from '../database/schema';
import { TenantContextService } from '../database/tenant-context.service';

/**
 * 项目查询（租户隔离 demo 面）。
 * 应用层按租户上下文过滤（项目边界=应用层，spec §7.1），RLS 是数据库层兜底——
 * 即使应用层漏过滤，客户连接也查不到他租户的行。
 * 不可见统一 404（非 403）：不暴露资源存在性。
 */
@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(): Promise<ProjectsListResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const rows = ctx.isInternal
      ? await this.db.select().from(projects).orderBy(projects.createdAt)
      : await this.db
          .select()
          .from(projects)
          .where(eq(projects.tenantId, ctx.tenantId!))
          .orderBy(projects.createdAt);
    return { projects: rows.map(toProjectDto) };
  }

  async getById(id: string): Promise<ProjectGetResponse> {
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
