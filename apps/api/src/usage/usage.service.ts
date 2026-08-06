import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { and, count, eq, gte, lte, sql } from 'drizzle-orm';
import { can, type FunctionalRole } from '@monitor/shared';
import type {
  UsageSummaryQuery,
  UsageSummaryResponse,
  UsageTrendQuery,
  UsageTrendResponse,
} from '@monitor/contracts';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import type { AuthUser } from '../common/current-user.decorator';
import { DRIZZLE, type Database } from '../database/database.module';
import { aiUsage, customers, projects } from '../database/schema';

/**
 * AI Token 用量统计（issue #23，spec #77–#79）：内部专属（agent:use 同权限域，
 * 客户 403 兜底 + RLS internal_bypass fail closed）；按客户/项目/场景/模型分组汇总
 * + date_trunc 时间序列趋势。成本字段（costUsd）为预留——memory fake 阶段无真实
 * 单价恒 null；Phase 2 客户 AI 成本视图 = sum(costUsd) + RAG Index 规格费。
 */
@Injectable()
export class UsageService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** 用量查看权限 = agent:use（AI 功能域，不新增权限点——矩阵定稿契约最小改动） */
  assertUsageView(actor: AuthUser): void {
    if (!can(actor.role as FunctionalRole, 'agent:use')) {
      throw new ForbiddenException('仅内部用户可查看 AI 用量');
    }
  }

  /** 四维分组汇总（每维一组行；null 归属 → 「未归属」组） */
  async summary(query: UsageSummaryQuery, actor: AuthUser): Promise<UsageSummaryResponse> {
    const where = this.buildFilters(query);

    const [totalRow] = await this.db
      .select({
        calls: count(),
        inputTokens: sql<string>`coalesce(sum(${aiUsage.inputTokens}), 0)`,
        outputTokens: sql<string>`coalesce(sum(${aiUsage.outputTokens}), 0)`,
        costUsd: sql<string | null>`sum(${aiUsage.costUsd})`,
      })
      .from(aiUsage)
      .where(where);

    const [byCustomer, byProject, byScene, byModel] = await Promise.all([
      this.groupedBy(aiUsage.customerId, customers.name, where),
      this.groupedBy(aiUsage.projectId, projects.name, where),
      this.groupedBy(aiUsage.scene, null, where),
      this.groupedBy(aiUsage.model, null, where),
    ]);

    await this.audit.record(AUDIT_ACTIONS.USAGE_VIEW, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'ai_usage',
      metadata: { endpoint: 'summary', ...query },
    });

    return {
      total: {
        calls: Number(totalRow?.calls ?? 0),
        inputTokens: Number(totalRow?.inputTokens ?? 0),
        outputTokens: Number(totalRow?.outputTokens ?? 0),
        totalCostUsd: totalRow?.costUsd == null ? null : Number(totalRow.costUsd),
      },
      byCustomer,
      byProject,
      byScene,
      byModel,
    };
  }

  /** 时间序列（date_trunc day/month；granularity 为契约枚举，无注入面） */
  async trend(query: UsageTrendQuery, actor: AuthUser): Promise<UsageTrendResponse> {
    const granularity = query.granularity === 'month' ? 'month' : 'day';
    // granularity 为契约枚举（day/month），raw 内联安全；同一字符串保证 select/groupBy 文本一致
    const bucketExpr = `date_trunc('${granularity}', created_at)`;
    const bucket = sql.raw(bucketExpr);

    const rows = await this.db
      .select({
        bucket: sql<string>`${bucket}`,
        calls: count(),
        inputTokens: sql<string>`coalesce(sum(${aiUsage.inputTokens}), 0)`,
        outputTokens: sql<string>`coalesce(sum(${aiUsage.outputTokens}), 0)`,
      })
      .from(aiUsage)
      .where(this.buildFilters(query))
      .groupBy(bucket)
      .orderBy(bucket);

    await this.audit.record(AUDIT_ACTIONS.USAGE_VIEW, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'ai_usage',
      metadata: { endpoint: 'trend', ...query },
    });

    return {
      points: rows.map((r) => ({
        bucket: new Date(r.bucket).toISOString(),
        calls: Number(r.calls),
        inputTokens: Number(r.inputTokens),
        outputTokens: Number(r.outputTokens),
      })),
    };
  }

  /** 单维分组聚合（nameColumn 为 leftJoin 的展示名列；null → 未归属） */
  private async groupedBy(
    keyColumn: typeof aiUsage.customerId | typeof aiUsage.projectId | typeof aiUsage.scene | typeof aiUsage.model,
    nameColumn: typeof customers.name | typeof projects.name | null,
    where: ReturnType<typeof this.buildFilters>,
  ): Promise<UsageSummaryResponse['byCustomer']> {
    const rows = await this.db
      .select({
        key: keyColumn,
        // 无展示名列（scene/model 维度）→ 常量 null；GROUP BY 不能含 null 字面量（PG 报错）
        name: nameColumn ?? sql<string | null>`null`,
        calls: count(),
        inputTokens: sql<string>`coalesce(sum(${aiUsage.inputTokens}), 0)`,
        outputTokens: sql<string>`coalesce(sum(${aiUsage.outputTokens}), 0)`,
        costUsd: sql<string | null>`sum(${aiUsage.costUsd})`,
      })
      .from(aiUsage)
      .leftJoin(customers, eq(customers.id, aiUsage.customerId))
      .leftJoin(projects, eq(projects.id, aiUsage.projectId))
      .where(where)
      .groupBy(keyColumn, ...(nameColumn ? [nameColumn] : []));
    return rows.map((r) => ({
      key: r.key ?? null,
      // 客户/项目维度 name = 表 join 名（null → 未归属）；场景/模型维度无展示列 → name = key
      name: nameColumn ? (r.name ?? '未归属') : (r.key ?? '未归属'),
      calls: Number(r.calls),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      costUsd: r.costUsd == null ? null : Number(r.costUsd),
    }));
  }

  /** 筛选条件（全部 optional；无条件 → undefined 全量） */
  private buildFilters(q: { customerId?: string; projectId?: string; scene?: string; model?: string; from?: string; to?: string }) {
    const conds = [];
    if (q.customerId) conds.push(eq(aiUsage.customerId, q.customerId));
    if (q.projectId) conds.push(eq(aiUsage.projectId, q.projectId));
    if (q.scene) conds.push(eq(aiUsage.scene, q.scene));
    if (q.model) conds.push(eq(aiUsage.model, q.model));
    if (q.from) conds.push(gte(aiUsage.createdAt, new Date(q.from)));
    if (q.to) conds.push(lte(aiUsage.createdAt, new Date(q.to)));
    return conds.length > 0 ? and(...conds) : undefined;
  }
}
