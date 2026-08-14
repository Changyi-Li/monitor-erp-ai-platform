import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, max, sql, type SQL } from 'drizzle-orm';
import {
  type ManualAssembleResponse,
  type ManualChapter,
  type ManualChapterResponse,
  type ManualChapterUpdateRequest,
  type ManualCreateRequest,
  type ManualGeneration,
  type ManualGenerationDetail,
  type ManualGenerationDetailResponse,
  type ManualGenerationsListResponse,
  type ProjectViewerRole,
} from '@monitor/contracts';
import { can } from '@monitor/shared';
import { LLM } from '../adapters/llm/llm.module';
import type { LLMClient } from '../adapters/llm/llm-client.port';
import { STORAGE } from '../adapters/storage/storage.module';
import type { StoragePort } from '../adapters/storage/storage.port';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/current-user.decorator';
import { DRIZZLE, type Database } from '../database/database.module';
import {
  blueprintVersions,
  blueprints,
  customers,
  manualChapters,
  manualGenerations,
  projects,
  users,
  type BlueprintVersionRow,
  type ManualChapterRow,
  type ManualGenerationRow,
} from '../database/schema';
import { TenantContextService, type TenantContext } from '../database/tenant-context.service';
import { KbService } from '../kb/kb.service';
import { MembersService } from '../projects/members.service';
import { assembleManual } from './assembler';
import { flowToText, parseDrawioXml } from './drawio-parser';

/** LLM 大纲输出的章节形状（memory fake 确定性 JSON；真实模型同契约，zod 校验） */
interface OutlineChapter {
  seq: number;
  title: string;
  outline: string;
}

/**
 * 操作手册自动生成（issue #26，spec §6）：「选蓝图版本 + 客户数据 → draw.io 流程解析 →
 * 分章节 LLM 生成（scene='manual_generation'）→ 逐章审校/重生成 → 组装 → 落项目 kb 草稿」。
 * 两层边界（同 issues/blueprints）：租户 RLS 兜底 + 应用层项目成员校验；查看 = 项目成员，
 * 维护 = manual:generate（仅内部/超管，spec §2.4 手册维护仅内部）。
 * AC4 stale 读时计算：generation 存 blueprint_id+version，列表 join max(version) 比较，
 * 蓝图新版本发布不覆盖已审校内容（再生成 = 新会话新草稿）。
 */
@Injectable()
export class ManualService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(LLM) private readonly llm: LLMClient,
    private readonly tenantContext: TenantContextService,
    private readonly members: MembersService,
    private readonly audit: AuditService,
    private readonly kb: KbService,
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

  /** 生成会话（RLS 租户过滤 + 项目维度校验 → 404 防探测） */
  private async requireGeneration(
    projectId: string,
    generationId: string,
  ): Promise<ManualGenerationRow> {
    const [row] = await this.db
      .select()
      .from(manualGenerations)
      .where(and(eq(manualGenerations.id, generationId), eq(manualGenerations.projectId, projectId)))
      .limit(1);
    if (!row) {
      throw new NotFoundException('手册生成会话不存在');
    }
    return row;
  }

  /** 章节（RLS 租户过滤 + 会话维度校验 → 404 防探测） */
  private async requireChapter(
    generationId: string,
    chapterId: string,
  ): Promise<ManualChapterRow> {
    const [row] = await this.db
      .select()
      .from(manualChapters)
      .where(and(eq(manualChapters.id, chapterId), eq(manualChapters.generationId, generationId)))
      .limit(1);
    if (!row) {
      throw new NotFoundException('章节不存在');
    }
    return row;
  }

  /** 角色级权限检查：维护 = manual:generate（仅内部/超管） */
  private assertGenerate(viewerRole: ProjectViewerRole, message: string): void {
    if (!can(viewerRole, 'manual:generate')) {
      throw new ForbiddenException(message);
    }
  }

  /** 蓝图版本（含 drawio key；RLS：内部 bypass + 客户租户隔离） */
  private async requireBlueprintVersion(
    blueprintId: string,
    version: number,
  ): Promise<BlueprintVersionRow> {
    const [row] = await this.db
      .select()
      .from(blueprintVersions)
      .where(and(eq(blueprintVersions.blueprintId, blueprintId), eq(blueprintVersions.version, version)))
      .limit(1);
    if (!row) {
      throw new NotFoundException('蓝图版本不存在');
    }
    return row;
  }

  // ---- 会话 ----

  /** 列表（按项目过滤；stale = 蓝图已发布更新版本，读时计算） */
  async listGenerations(projectId: string, actor: AuthUser): Promise<ManualGenerationsListResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId);
    await this.resolveViewerRole(projectId, ctx);

    const rows = await this.db
      .select({ generation: manualGenerations, createdByName: users.displayName })
      .from(manualGenerations)
      .leftJoin(users, eq(users.id, manualGenerations.createdById))
      .where(eq(manualGenerations.projectId, projectId))
      .orderBy(desc(manualGenerations.createdAt));

    const generations = await this.toGenerationDtos(rows.map((r) => r.generation), rows);
    return { generations };
  }

  /** 详情 = 会话 + 章节列表（生成进度/审校/组装页一步到位） */
  async getGeneration(
    projectId: string,
    generationId: string,
    actor: AuthUser,
  ): Promise<ManualGenerationDetailResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId);
    await this.resolveViewerRole(projectId, ctx);
    const row = await this.requireGeneration(projectId, generationId);
    const [joined] = await this.db
      .select({ generation: manualGenerations, createdByName: users.displayName })
      .from(manualGenerations)
      .leftJoin(users, eq(users.id, manualGenerations.createdById))
      .where(eq(manualGenerations.id, row.id))
      .limit(1);

    const chapters = await this.chaptersOf(row.id);
    const dto = await this.toGenerationDto(joined?.generation ?? row, joined?.createdByName ?? null);
    return {
      generation: { ...dto, chapters: chapters.map(toChapterDto) },
    };
  }

  /**
   * 创建会话：校验蓝图版本 → 取 drawio 解析流程 → LLM 章节大纲（scene='manual_generation'）
   * → 落 generation + 章节（pending）。LLM 输出非法 → 500（场景名带出，便于配置排查）。
   */
  async createGeneration(
    projectId: string,
    actor: AuthUser,
    input: ManualCreateRequest,
  ): Promise<ManualGenerationDetailResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const project = await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertGenerate(viewerRole, '仅内部用户可生成操作手册');

    const [blueprint] = await this.db
      .select()
      .from(blueprints)
      .where(eq(blueprints.projectId, projectId))
      .limit(1);
    if (!blueprint) {
      throw new NotFoundException('该项目尚未创建蓝图');
    }
    const versionRow = await this.requireBlueprintVersion(blueprint.id, input.blueprintVersion);

    // drawio 流程解析（缺失 → 400；解析空结构 → 以结构化字段兜底）
    const buffer = await this.storage.get(versionRow.drawioKey);
    if (!buffer) {
      throw new BadRequestException('蓝图文件缺失，无法生成手册');
    }
    const flowText = flowToText(parseDrawioXml(buffer.toString('utf-8')));
    const structured = [
      versionRow.businessRequirements && `业务需求：${versionRow.businessRequirements}`,
      versionRow.moduleScope && `模块范围：${versionRow.moduleScope}`,
      versionRow.configNotes && `配置说明：${versionRow.configNotes}`,
      versionRow.processDescription && `流程描述：${versionRow.processDescription}`,
    ]
      .filter(Boolean)
      .join('\n');
    if (!flowText && !structured) {
      throw new BadRequestException('蓝图无可生成内容（缺少流程图与结构化描述）');
    }

    const [customer] = await this.db
      .select({ name: customers.name })
      .from(customers)
      .where(eq(customers.id, project.tenantId))
      .limit(1);

    // 大纲调用（memory fake 确定性 JSON；真实模型经 LLM_DRIVER_MANUAL_GENERATION）
    const system = [
      '[操作手册生成]',
      '你正在为客户的实施项目生成操作手册。请基于蓝图的流程描述规划章节大纲。',
      '[蓝图流程]',
      flowText || structured,
      '[项目上下文]',
      `项目：${project.id}｜客户：${customer?.name ?? ''}｜蓝图版本：v${input.blueprintVersion}`,
    ].join('\n');
    const { content } = await this.llm.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: '请生成章节大纲（JSON：{chapters:[{seq,title,outline}]}）。' },
      ],
      context: { scene: 'manual_generation', projectId, customerId: project.tenantId },
    });

    const outlineChapters = parseOutlineJson(content);
    if (outlineChapters.length === 0) {
      throw new InternalServerErrorException(
        `章节大纲解析失败（scene=manual_generation），请检查 LLM 驱动配置`,
      );
    }

    const title = input.title ?? `${blueprint.drawioName} 操作手册 v${input.blueprintVersion}`;
    const [generation] = await this.db
      .insert(manualGenerations)
      .values({
        tenantId: project.tenantId,
        projectId,
        blueprintId: blueprint.id,
        blueprintVersion: input.blueprintVersion,
        title,
        createdById: actor.sub,
      })
      .returning();
    if (!generation) {
      throw new InternalServerErrorException('创建手册生成会话失败');
    }
    await this.db.insert(manualChapters).values(
      outlineChapters.map((chapter) => ({
        tenantId: project.tenantId,
        generationId: generation.id,
        seq: chapter.seq,
        title: chapter.title,
        outline: chapter.outline,
      })),
    );

    await this.audit.record(AUDIT_ACTIONS.MANUAL_CREATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'manual_generation',
      resourceId: generation.id,
      metadata: {
        projectId,
        blueprintId: blueprint.id,
        blueprintVersion: input.blueprintVersion,
        chapterCount: outlineChapters.length,
      },
    });

    const chapters = await this.chaptersOf(generation.id);
    const dto = await this.toGenerationDto(generation, null);
    return { generation: { ...dto, chapters: chapters.map(toChapterDto) } };
  }

  // ---- 章节 ----

  /** 单章生成/重生成：LLM 正文调用（覆盖 content_md，状态回 ready；失败保持原状可重试） */
  async generateChapter(
    projectId: string,
    generationId: string,
    chapterId: string,
    actor: AuthUser,
  ): Promise<ManualChapterResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertGenerate(viewerRole, '仅内部用户可生成操作手册');
    const generation = await this.requireGeneration(projectId, generationId);
    const chapter = await this.requireChapter(generationId, chapterId);

    const buffer = await this.storage.get(
      await this.blueprintDrawioKey(generation.blueprintId, generation.blueprintVersion),
    );
    const flowText = buffer ? flowToText(parseDrawioXml(buffer.toString('utf-8'))) : '';

    const system = [
      '[操作手册生成]',
      '你正在为客户撰写操作手册章节正文（Markdown）。基于蓝图流程编写操作步骤。',
      '[蓝图流程]',
      flowText || '(无流程文本，请基于章节标题合理编写)',
    ].join('\n');
    const { content } = await this.llm.chat({
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `请生成第 ${chapter.seq} 章「${chapter.title}」的正文，章节大纲：${chapter.outline ?? ''}`,
        },
      ],
      context: { scene: 'manual_generation', projectId, customerId: generation.tenantId },
    });
    if (!content.trim()) {
      throw new InternalServerErrorException('章节生成失败（空内容），请重试');
    }

    const [updated] = await this.db
      .update(manualChapters)
      .set({
        contentMd: content.trim(),
        status: 'ready',
        aiGeneratedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(manualChapters.id, chapter.id))
      .returning();
    if (!updated) {
      throw new NotFoundException('章节不存在');
    }
    await this.audit.record(AUDIT_ACTIONS.MANUAL_CHAPTER_GENERATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'manual_chapter',
      resourceId: chapter.id,
      metadata: { generationId, seq: chapter.seq, title: chapter.title },
    });
    return { chapter: toChapterDto(updated) };
  }

  /** 章节审校保存（人工修改 → status='edited'；不限制内容，仅校验存在） */
  async updateChapter(
    projectId: string,
    generationId: string,
    chapterId: string,
    actor: AuthUser,
    input: ManualChapterUpdateRequest,
  ): Promise<ManualChapterResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertGenerate(viewerRole, '仅内部用户可维护操作手册');
    await this.requireGeneration(projectId, generationId);
    const chapter = await this.requireChapter(generationId, chapterId);

    const [updated] = await this.db
      .update(manualChapters)
      .set({
        title: input.title ?? chapter.title,
        outline: input.outline ?? chapter.outline,
        contentMd: input.contentMd ?? chapter.contentMd,
        status: 'edited',
        editedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(manualChapters.id, chapter.id))
      .returning();
    if (!updated) {
      throw new NotFoundException('章节不存在');
    }
    await this.audit.record(AUDIT_ACTIONS.MANUAL_CHAPTER_UPDATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'manual_chapter',
      resourceId: chapter.id,
      metadata: { generationId, seq: chapter.seq, title: updated.title },
    });
    return { chapter: toChapterDto(updated) };
  }

  // ---- 组装 / 发布 ----

  /** 组装预览：整本 Markdown（≥1 章有内容，否则 400） */
  async assemble(
    projectId: string,
    generationId: string,
    actor: AuthUser,
  ): Promise<ManualAssembleResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const project = await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertGenerate(viewerRole, '仅内部用户可操作手册');
    const generation = await this.requireGeneration(projectId, generationId);
    const chapters = await this.chaptersOf(generation.id);

    const body = await this.assembleBody(project, generation, chapters);
    await this.audit.record(AUDIT_ACTIONS.MANUAL_ASSEMBLE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'manual_generation',
      resourceId: generation.id,
      metadata: { projectId, chapterCount: chapters.length },
    });
    return { body };
  }

  /**
   * 发布：再次组装 → 落项目 kb 草稿（category='manual'，projectId 挂靠）→ 回填
   * kb_document_id/status='published'。不自动发布 kb 草稿——用户走 kb 详情页发布端点
   * （此时 scope='customer' 路由生效进客户 Index，issue #26 AC3）。
   */
  async publishToKb(
    projectId: string,
    generationId: string,
    actor: AuthUser,
  ): Promise<ManualGenerationDetailResponse> {
    const ctx = this.tenantContext.current;
    if (!ctx) {
      throw new InternalServerErrorException('缺少租户上下文');
    }
    const project = await this.requireProject(projectId);
    const viewerRole = await this.resolveViewerRole(projectId, ctx);
    this.assertGenerate(viewerRole, '仅内部用户可发布操作手册');
    const generation = await this.requireGeneration(projectId, generationId);
    if (generation.status === 'published') {
      throw new BadRequestException('该会话已发布，重新生成请新建会话');
    }
    const chapters = await this.chaptersOf(generation.id);
    const body = await this.assembleBody(project, generation, chapters);

    const { document } = await this.kb.createDocument(actor, {
      docType: 'markdown',
      projectId,
      title: generation.title,
      category: 'manual',
      body,
    });

    const [updated] = await this.db
      .update(manualGenerations)
      .set({
        status: 'published',
        kbDocumentId: document.id,
        updatedAt: new Date(),
      })
      .where(eq(manualGenerations.id, generation.id))
      .returning();
    if (!updated) {
      throw new NotFoundException('手册生成会话不存在');
    }
    await this.audit.record(AUDIT_ACTIONS.MANUAL_PUBLISH, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'manual_generation',
      resourceId: generation.id,
      metadata: { projectId, kbDocumentId: document.id },
    });

    const dto = await this.toGenerationDto(updated, null);
    return { generation: { ...dto, chapters: chapters.map(toChapterDto) } };
  }

  // ---- 内部 ----

  /** 组装正文（项目名/客户名 join；≥1 章有内容，否则 400） */
  private async assembleBody(
    project: { id: string; tenantId: string },
    generation: ManualGenerationRow,
    chapters: ManualChapterRow[],
  ): Promise<string> {
    const [projectRow] = await this.db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, project.id))
      .limit(1);
    const [customer] = await this.db
      .select({ name: customers.name })
      .from(customers)
      .where(eq(customers.id, project.tenantId))
      .limit(1);
    if (!chapters.some((c) => c.contentMd !== null && c.contentMd.trim().length > 0)) {
      throw new BadRequestException('手册尚无已生成章节，请先生成章节正文');
    }
    return assembleManual({
      title: generation.title,
      projectName: projectRow?.name ?? '',
      customerName: customer?.name ?? '',
      blueprintVersion: generation.blueprintVersion,
      chapters: chapters.map((c) => ({ seq: c.seq, title: c.title, contentMd: c.contentMd })),
    });
  }

  /** 会话的章节（seq 升序） */
  private async chaptersOf(generationId: string): Promise<ManualChapterRow[]> {
    return this.db
      .select()
      .from(manualChapters)
      .where(eq(manualChapters.generationId, generationId))
      .orderBy(manualChapters.seq);
  }

  /** 蓝图指定版本的 drawio key（generateChapter 复用） */
  private async blueprintDrawioKey(blueprintId: string, version: number): Promise<string> {
    const [row] = await this.db
      .select({ drawioKey: blueprintVersions.drawioKey })
      .from(blueprintVersions)
      .where(and(eq(blueprintVersions.blueprintId, blueprintId), eq(blueprintVersions.version, version)))
      .limit(1);
    return row?.drawioKey ?? '';
  }

  /** 批量组装 DTO（列表用）：stale 读时计算 + 章节进度批量查 + 创建人名 */
  private async toGenerationDtos(
    rows: ManualGenerationRow[],
    joined: { generation: ManualGenerationRow; createdByName: string | null }[],
  ): Promise<ManualGeneration[]> {
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((r) => r.id);
    const [versionRows, readyRows, totalRows] = await Promise.all([
      this.db
        .select({ blueprintId: blueprintVersions.blueprintId, maxVersion: max(blueprintVersions.version) })
        .from(blueprintVersions)
        .where(inArray(blueprintVersions.blueprintId, rows.map((r) => r.blueprintId)))
        .groupBy(blueprintVersions.blueprintId),
      this.db
        .select({
          generationId: manualChapters.generationId,
          count: sql<number>`count(*)`,
        })
        .from(manualChapters)
        .where(
          and(
            inArray(manualChapters.generationId, ids),
            inArray(manualChapters.status, ['ready', 'edited']),
          ),
        )
        .groupBy(manualChapters.generationId),
      this.chapterCounts(ids),
    ]);
    const maxByBlueprint = new Map(versionRows.map((r) => [r.blueprintId, r.maxVersion ?? 0]));
    const readyByGeneration = new Map(readyRows.map((r) => [r.generationId, Number(r.count)]));
    const totalByGeneration = totalRows;
    const nameById = new Map(joined.map((r) => [r.generation.id, r.createdByName]));

    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      blueprintId: row.blueprintId,
      blueprintVersion: row.blueprintVersion,
      title: row.title,
      status: row.status as ManualGeneration['status'],
      stale: (maxByBlueprint.get(row.blueprintId) ?? 0) > row.blueprintVersion,
      currentBlueprintVersion: (maxByBlueprint.get(row.blueprintId) ?? 0) || null,
      kbDocumentId: row.kbDocumentId,
      chapterCount: totalByGeneration.get(row.id) ?? 0,
      readyCount: readyByGeneration.get(row.id) ?? 0,
      createdBy: row.createdById
        ? { id: row.createdById, displayName: nameById.get(row.id) ?? '' }
        : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /** 批量章节总数（chapterCount） */
  private async chapterCounts(generationIds: string[]): Promise<Map<string, number>> {
    if (generationIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .select({ generationId: manualChapters.generationId, count: sql<number>`count(*)` })
      .from(manualChapters)
      .where(inArray(manualChapters.generationId, generationIds))
      .groupBy(manualChapters.generationId);
    return new Map(rows.map((r) => [r.generationId, Number(r.count)]));
  }

  /** 单个 DTO（详情用；stale 计算同列表） */
  private async toGenerationDto(
    row: ManualGenerationRow,
    createdByName: string | null,
  ): Promise<ManualGeneration> {
    const [dto] = await this.toGenerationDtos([row], [
      { generation: row, createdByName },
    ]);
    return dto!;
  }
}

/** DB 行 → 契约章节 */
function toChapterDto(row: ManualChapterRow): ManualChapter {
  return {
    id: row.id,
    seq: row.seq,
    title: row.title,
    outline: row.outline,
    contentMd: row.contentMd,
    status: row.status as ManualChapter['status'],
    aiGeneratedAt: row.aiGeneratedAt ? row.aiGeneratedAt.toISOString() : null,
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** LLM 输出 → 大纲章节数组（剥 ``` 围栏；JSON.parse；数组形状容错） */
function parseOutlineJson(content: string): OutlineChapter[] {
  const stripped = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const parsed: unknown = JSON.parse(stripped);
    const chapters = Array.isArray(parsed)
      ? parsed
      : (parsed as { chapters?: unknown }).chapters;
    if (!Array.isArray(chapters)) {
      return [];
    }
    return chapters
      .filter(
        (c): c is OutlineChapter =>
          typeof c === 'object' &&
          c !== null &&
          typeof (c as OutlineChapter).seq === 'number' &&
          typeof (c as OutlineChapter).title === 'string',
      )
      .map((c) => ({
        seq: c.seq,
        title: c.title,
        outline: typeof c.outline === 'string' ? c.outline : '',
      }));
  } catch {
    return [];
  }
}
