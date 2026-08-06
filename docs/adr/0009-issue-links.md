# 0009: 问题关联蓝图/文档（多态关联表 + 零新增权限）+ 提交人筛选/姓名回显

Status: accepted

## 背景

#20 交付问题清单增强（spec §3.5 + 用户故事 41/42）：**问题可关联蓝图/功能/文档**（便于追溯）、**列表按分类/优先级/状态/提交人筛选 + 关键词搜索**。探索发现 #15 已交付评论（AC1）与筛选搜索大半（AC3）——本票增量 = **关联（AC2）+ 提交人筛选 + 提交人姓名回显**（补 ADR 0004 已知取舍）+ 前端。数据边界 = 项目（同 #15）。

## 关联目标：蓝图 / 会议纪要 / 知识库文档（多态，无 FK）

spec 42「关联蓝图/功能/文档」经用户确认：蓝图（blueprint）+ 会议纪要（minute）+ 知识库文档（kb_document）。**「功能」无独立实体**（蓝图内 moduleScope/功能范围是文本字段）→ 不实体化，蓝图关联即功能范围追溯（取舍写入本 ADR）。

实现 = **多态关联表 `issue_links`**（迁移 0010）：`issueId`（FK issues cascade——链接随问题删）+ `targetType`（text + check）+ `targetId` + 冗余 `tenantId`（供 RLS，同 issues 模式）+ `createdById`。**无 FK 到目标**——跨表多态无法表达 FK，service 层校验存在性 + 项目归属；`unique(issueId, targetType, targetId)` 防重复关联（DB 兜底，service 先查给 400「已关联该对象」而非 500 唯一冲突）。目标删除后 link 行不自动删（无 FK cascade）——展示层容忍：详情组装时目标查不到 → `targetTitle: null` → 前端显示「（不可见）」。

## 目标校验：项目归属 + kb 走 RLS 天然过滤（关键语义）

- `blueprint` / `minute`：查目标表 `where id = targetId and projectId = issue.projectId` → 不存在/跨项目 → 400（防跨项目关联）
- `kb_document`：查 `kb_documents where id = targetId` **走 RLS 天然过滤**——内部（internal_manage，ADR 0008）任意状态；客户 PM（read_published）只见已发布，关联草稿/归档 → 查不到 → 400。零额外逻辑，正好复用 #19 全局 RLS 语义

## 权限：零新增（关联 = 修改/管理问题 → 复用 issue:manage）

矩阵无「关联」行；关联/解除属于「问题清单 — 修改/管理」（spec 38 PM 含指派、优先级调整）→ `issue:manage`（内部 + 客户 PM）。KeyUser/普通用户 403。查看关联 = 详情内嵌 links（全员，spec 40「查看项目问题列表」）。

## 详情/列表响应扩展

- `IssueGetResponse` + `links: IssueLinkDto[]`：`{id, issueId, targetType, targetId, targetTitle, createdBy, createdAt}`。targetTitle = blueprint → drawio 文件名、minute/kb → 标题——**分三批批量查询（inArray 按类型分组）内存组装，避免多态 join**；创建人姓名同批 join
- `Issue` + `reporterName`（join users，删除 → null，补 ADR 0004 取舍）；列表/详情/创建/更新/流转响应统一回显
- `IssuesListQuery` + `reporterId` filter（spec 41「按提交人筛选」）

## 审计

AUDIT_ACTIONS + `issue.link`（metadata: targetType/targetId）、`issue.unlink`（同），成功才记录、请求事务内写入（同先例）。

## 已知取舍

- 「功能」无独立实体不实体化（见上）；蓝图关联即功能范围追溯
- 多态关联无 FK 到目标 → service 校验 + unique 防重；目标删除后 link 行残留，targetTitle 显示「（不可见）」不报错
- 前端提交人筛选下拉选项 = 当前列表数据去重（Phase 1 量小，无成员名单端点；内部用户视角可覆盖全量提交人）
- 前端添加关联目标下拉复用既有列表端点（blueprints 项目唯一单对象 / minutes 列表 / kb 列表）——客户 PM 的 kb 下拉自动只见已发布（RLS）
- 关联无分页；web 无自动化 e2e（无 Playwright 基建），验收 = 页面实现 + `pnpm build` + 后端 e2e 全绿（同 #15–#19 模式）
