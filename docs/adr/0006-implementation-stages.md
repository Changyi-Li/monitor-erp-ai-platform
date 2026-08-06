# 0006: 实施阶段与风险（阶段模板 + 看板 + 项目级风险）

Status: accepted

## 背景

#17 交付实施进度域（spec §3.3）：**标准阶段模板** → 项目内实例化阶段（增删/排序/状态流转）；**项目级风险点**（描述/等级 高/中/低/状态/负责人）可关联具体阶段；客户用户只读查看。数据边界 = 项目（#13 已定）。

## 权限落点：查看复用 phase:view，新增 phase:manage + risk:manage

spec §2.4 已定义「查看实施阶段」= 全员（矩阵已有 `phase:view`，line 77）、「阶段/风险维护」= 仅内部/超管（line 81）。本期新增两个权限点，均仅 `super_admin/internal`：

- **`phase:manage`**：阶段创建/编辑/删除/排序/状态流转
- **`risk:manage`**：风险创建/编辑/删除

风险**查看**不设独立权限点：风险是阶段域的一部分，查看端点复用 `phase:view`（项目成员即可，验收③「客户只读查看阶段进度与风险」）。与 issues 的「查看 = 成员」模式一致，矩阵不膨胀。

项目级权限沿用 #14/#15/#16 模式**不建 guard**：service 层 `resolveViewerRole`（内部 → 'internal'；客户用户须为 active 成员，非成员 403）+ `can()` 断言。403 vs 404 语义同前：跨租户（RLS 兜底）→ 404 防探测；同租户无权限 → 403。

## 数据模型：两表，RLS 双策略（同 projects/issues 同构）

- `project_stages`：**一个项目多阶段**。字段：templateKey（来源模板，可空 = 自定义）、name、description、status（`not_started/in_progress/completed/paused`，text + check()）、sortOrder（项目内排序，重排时整体重写）。
- `project_risks`：**项目级**（可跨阶段存在）。字段：stageId（FK → project_stages **onDelete set null**——阶段删除后风险保留、解除关联）、description、level（`high/medium/low`）、status（`open/in_progress/resolved`）、ownerId（FK → users set null，负责人仅限内部）。

两表均 `enableRLS()` + 双策略（`*_tenant_isolation` + `*_internal_bypass`），迁移 0006 零改动现有表；GRANT 由 0001 的 ALTER DEFAULT PRIVILEGES 自动覆盖。

## 标准阶段模板 = 内置常量，不做模板表

spec §3.3「基于标准阶段模板」验收①。**Phase 1 模板为 `packages/shared` 常量**（STAGE_TEMPLATES：需求分析/蓝图设计/系统配置/测试验收/上线支持），经 `GET /projects/:id/stages/templates` 只读暴露：

- 验收未要求模板维护（增删模板）；无跨租户共享表（模板是平台级数据，不归任何客户，塞 tenant 表反而要特判 RLS）
- 前端建阶段 = 模板下拉（选中自动填充名称/描述，可改）+ templateKey 落库记录来源；自定义阶段 templateKey = null
- 后续要可配置模板时再加平台级表 + 内部维护端点，业务代码零改动（常量换查询源）

## 阶段状态：自由流转，无 issues 式严格状态机

issues 的四态是**严格线性**（#15 用户确认：仅三条合法边）。阶段四态（未开始/进行中/已完成/已暂停）spec 未定义流转规则，且「已暂停 → 进行中」天然是回退边——**允许任意状态间自由切换**（PATCH status 直接生效，仅 check 约束 + 契约枚举校验），前端看板卡片用 select 直接切。演示与工程都更简单；若后续要审批流再加状态机（纯函数，同 issue-status.ts 模式）。

## 排序：全量重排（PUT reorder），不做拖拽库

验收①「增删/排序调整」。方案：`PUT /projects/:id/stages/reorder {stageIds: [...]}` 全量目标顺序，服务层校验（含无效/跨项目 id → 400）后按索引重写 sortOrder；前端卡片提供 ↑/↓ 按钮交换（构造新顺序 PUT）。**不引入拖拽库**（无 UI 依赖是本仓库约束），sortOrder 无 unique 约束（重排的交换原子性由全量重写 + 单表小量级兜底）。

## 风险负责人：仅限内部用户

ownerId 候选 = 内部/超管 active 用户（`GET /projects/:id/risks/assignees`，复用 issues assignees 的响应形状 `{assignees}`）。服务层校验：非内部 active 用户 → 400（同 issues 指派校验）。客户项目经理**不可**被指派为风险负责人——spec §3.3「负责人」未明示，但风险处置是实施工作（line 81 风险管理仅内部），与 issue 指派内部负责人（spec 37）对齐。

## 审计

AUDIT_ACTIONS 新增 7 个动作：`stage.create/update/delete/reorder`（reorder 带 count + stageIds）、`risk.create/update/delete`。成功才记录、请求事务内写入（与 #13-#16 同模式）。读操作不审计（同 issues/blueprints 取舍）。

## 已知取舍

- 模板无维护端点（内置常量，见上）；无模板 key 变更迁移（常量追加 = 向后兼容）
- 排序无拖拽、无独立排序字段编辑 UI（↑/↓ 足够 Phase 1 量级）；sortOrder 空洞（删除后不压缩，重排时重写）
- 阶段无详情页（看板列表已含全字段）；风险无分页（Phase 1 量级小）
- web 无自动化 e2e（无 Playwright 基建），验收④ = 页面实现 + `pnpm build` + 后端 e2e 全绿 + demo path 手动走通（同 #15/#16 模式）
