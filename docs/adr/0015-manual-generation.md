# 0015: 操作手册自动生成（蓝图 → 分章 LLM → 审校 → 组装 → 落项目知识库）

Status: accepted

## 背景

客户操作手册目前人工编写（spec Problem）。#26 交付 spec §6「操作手册自动生成」：内部用户选蓝图版本 + 客户数据 → draw.io 流程解析为文本 → LLM 分章节生成 → 逐章审校/重生成 → 组装成册 → 落项目知识库文档（category='manual'）→ 发布进客户 Index。蓝图新版本发布后列表提示「建议重新生成」，**不覆盖已审校内容**。

依赖基础：#21 RAG 管线（ADR 0010）、#16 蓝图版本快照（ADR 0005）、LLM 场景接缝（ADR 0013）、ai_usage 计量（ADR 0012，`scene='manual_generation'` + projectId/customerId 列已预留）。

## 生成引擎：会话持久化 + 两个确定性 LLM 调用点

**生成会话 = 两表**（`manual_generations` + `manual_chapters`）：逐章审校/单独重生成/进度/AC4 stale 都需跨请求持久化。不做 LangGraph——REST 端点天然实现 HITL 审核环，checkpoint 无收益。

**两个 LLM 调用点**（同一 `scene='manual_generation'` 上下文，`{projectId, customerId: project.tenantId}`）：
1. **章节大纲**（创建会话时）：system 注入 `[操作手册生成]` 锚点 + `[蓝图流程]` 区块（drawio 解析文本，缺失时以结构化字段兜底）→ user 请求 JSON `{chapters:[{seq,title,outline}]}` → 剥 ``` 围栏 + zod 校验（非法 → 500 带场景名，便于定位驱动配置）。大纲调用在**请求事务内**（与 insert 同事务，失败全回滚）。
2. **单章正文**（逐章生成/重生成）：`第 N 章「标题」` 请求 → 覆盖 content_md/status='ready'/ai_generated_at。调用在**事务外**（避免长事务），失败章节保持原状可重试。

**memory fake 分支**（MemoryLlmAdapter，e2e 确定性）：锚点 `[操作手册生成]` 插在 `[图片解析]` 之后、检索分支之前（manual prompt 无 `[检索文档]` 区块，顺序天然安全）；两个确定性回复点与真实调用一一对应。**分支顺序陷阱**：manual.service 的正文请求含「章节大纲：{outline}」字样，因此正文正则（`第\s*N\s*章「标题」`，容忍空格）必须先于「章节大纲」字面匹配——否则正文调用误命中大纲分支。

## kb 项目文档挂靠（数据边界 = 项目，可见性 = 租户）

`kb_documents` 新增 `project_id`（FK projects SET NULL）+ `tenant_id`（FK customers SET NULL），**可空，NULL = 全局文档**（内部知识库，ADR 0008 语义不变）。发布 scope 路由仿蓝图（ADR 0010 先例）：`row.projectId ? 'customer' : 'internal'`，tenantId 仅项目文档传递（SyncEnqueueInput 已支持）。创建时 service 校验项目存在（404 防探测）并从 projects 取 tenantId 落库。

**AC5 客户可见 = RLS + 服务层双保险**：`kb_documents_read_published` 策略改为 `published AND (tenant_id IS NULL OR tenant_id = 当前租户)`——用 **`ALTER POLICY` 原地替换**（drizzle-kit 生成，比 DROP+CREATE 更安全：permissive 策略 OR 语义，旧策略留存会把项目文档泄漏给全客户；原地替换无泄漏窗口）。服务层 listDocuments 客户分支再加同条件显式过滤（RLS 兜底外的双保险）。`kb_document_versions` 的子查询策略自动继承，零改动。

## stale = 读时计算（AC4）

generation 存 `blueprint_id + blueprint_version`；列表查询 distinct blueprintId 的 max(version) 比较 → `stale`/`currentBlueprintVersion`。零 publish 钩子，天然正确；**不覆盖**：再生成 = 新会话新草稿，旧手册保留（kb 层版本归并留待后续）。

## drawio 解析：自写轻量正则解析器（零 XML 依赖）

仓库零 XML 依赖；draw.io 的 `value` 是 HTML 实体串，XML 解析器仍要二次处理。`drawio-parser.ts`（~150 行纯函数）：`/<mxCell\b[^>]*>(?:\s*<mxGeometry\b[^>]*>)?/g` 窗口捕获开始标签 + 子标签 mxGeometry（容器/顶点必须且仅有此结构）→ 属性正则分类 vertex/edge → **容器 cell 跳过**（swimlane 标题作 section 标题，其子顶点按 parent 分组）→ (y,x) 排序 → `decodeXmlEntities`（单 pass，`&amp;` 最后解码防二次）→ `stripHtml`（br/div 转 \n 再剥标签）→ `flowToText` 输出 `## {section}` + 编号步骤 + `## 步骤连线` 喂 LLM。解析失败 → 空结构不抛错（与结构化字段兜底配合）。

## 组装与发布（纯函数复用 + 两步发布）

`assembler.ts`：`assembleManual` 纯函数（标题 + 元信息块 + 目录锚点 + 分章拼接；空章节跳过，目录同步跳过）——预览与发布共用同一实现，零漂移。

**发布 = 两步**：`publishToKb` 再次 assemble → `kb.createDocument({docType:'markdown', category:'manual', body, projectId})` → 回填 `kb_document_id`/status='published'。**不自动发布 kb 草稿**——用户走现有 `POST /kb/documents/:id/publish`（此时 scope='customer' 路由生效进客户 Index），人工把关与 RAG 同步触发点完全复用（ADR 0010 口径）。

## 权限

查看 = 项目成员（resolveViewerRole，同 blueprints 模式）；创建/章节生成/审校/组装/发布 = `manual:generate`（仅 internal/super_admin，spec §2.4 手册维护仅内部）。顺序：requireProject（RLS→404）→ resolveViewerRole（内部→'internal'/成员→role/非成员→403）→ assertGenerate（403）→ 资源查找（404）。**权限先于资源校验**（客户用假 id 调用 → 403 而非 404，e2e 锁定）。

## 审计

5 个动作全部落 audit_logs：`manual.create`（metadata 带 blueprintId/blueprintVersion/chapterCount）/ `manual.chapter_generate`（generationId/seq/title）/ `manual.chapter_update` / `manual.assemble` / `manual.publish`。

## 已知取舍

- 会话一次性（再生成 = 新会话新草稿，旧手册保留；Phase 1 接受，kb 层版本归并后续）。
- 章节 seq 固定不可拖拽；drawio 复杂样式（跨页/嵌入图）忽略（解析失败走结构化字段兜底）。
- 「全部生成」= 浏览器串行循环（非批量端点，Phase 1 量级 OK，单章失败可重试）。
- 客户可见是**租户级**非项目级（与 issues/blueprints RLS 一致，项目级可见性后续如需再做）。
- customer Index 是单一 scope Map（与蓝图一致，每客户独立 Index 是真实平台形态）。
- web 无自动化 e2e（无 Playwright 基建）：/manuals 验收 = 实现 + `pnpm build` + 后端 e2e 全绿（同 #15–#24 惯例）。
