# 0004: 问题清单（四态状态机 + 项目内权限矩阵）

Status: accepted

## 背景

#15 交付问题清单核心链路（spec §3.5 / 用户故事 36-43）：问题 CRUD + 四态状态机 + 项目内权限矩阵（spec §2.4 客户侧差异）+ 评论 + 指派内部负责人。数据边界 = 项目（#13 已定）；新增数据模型：`issues` + `issue_comments` 两表（迁移 0004，零改动现有表）。

## 权限矩阵落点：新增 issue:transition，其余复用

spec §2.4 已定义提交（全员）/ 评论（PM/KeyUser）/ 修改管理（PM+），#13 时已落 `PERMISSION_MATRIX`（`issue:create` / `issue:comment` / `issue:manage`）。本期唯一新增权限点：**`issue:transition`（super_admin/internal）**——状态流转 = 「内部处理问题」（spec 37），客户侧任何角色（含 PM）不可流转，矩阵行只挂内部两角色，`permissions.spec.ts` 同步断言。

项目级权限**不建 guard**（沿用 members 模式：guard 在 TenantInterceptor 之前运行，查库会落在租户事务外）：每个端点 service 层先 `resolveViewerRole`（内部 → 'internal'；客户用户须为该 active 项目成员，非成员 403），再 `can(viewerRole, permission)` 断言。403 vs 404 语义同 #12/#13：跨租户（RLS 兜底）→ 404 防探测；同租户无权限 → 403。

## 状态机：严格线性，纯函数 + 应用层强制

用户确认四态严格线性：仅 `new → in_progress → resolved → closed` 三条边，非法流转一律 400（验收 ②）。实现：

- `apps/api/src/issues/issue-status.ts`：`ISSUE_TRANSITIONS` 表 + `canTransition(from, to)` 纯函数（spec Testing Decisions 要求状态机单测——`issue-status.spec.ts` 覆盖合法/非法全组合）
- DB 层仅 `check` 约束枚举值合法性（text + check，仓库无 pgEnum 先例），**不表达流转图**（PG check 写线性图复杂且不可读；应用层是唯一事实源，单测兜底）
- 流转端点 POST（`@HttpCode(200)`——状态流转非创建资源，@Post 默认 201 语义不符）
- 流转请求在**同一租户事务**内完成 update + 审计（`issue.transition` 带 from/to metadata），失败整体回滚

## 数据模型：复制 projects 的 RLS 模式

`issues`：tenantId（FK customers，冗余供 RLS）+ projectId（FK projects，数据边界）+ 枚举列（type/category/priority/status，text + check）+ reporterId/assigneeId（FK users set null）。`issue_comments`：同构 tenantId + issueId（FK cascade）+ authorId（set null）+ content。两张表均 `enableRLS()` + 双策略（`*_tenant_isolation` + `*_internal_bypass`），与 projects 完全同构。

**两层边界**：RLS 按租户兜底（客户用户跨租户 → 查不到 → 404）；应用层按项目成员校验（同租户非成员 → 403）。列表按路径参数 `projectId` 精确过滤，配合 resolveViewerRole 已保证成员身份，无需成员项目交集（区别于 projects 全局列表的 `listMemberProjects` 双保险——全局列表才有跨项目枚举面）。

## 指派：仅内部用户候选

`assigneeId` 仅可指向 active 的 super_admin/internal 用户（spec 37「指派内部负责人」），service 层校验（查 users role + is_active，不满足 → 400）。PM 可指派（spec 38「含指派」）但候选端点 `GET /projects/:id/issues/assignees` 返回内部员工名单，仅 PM+ 可见（issue:manage 门槛，普通用户/KeyUser 拿不到名单）。null 清空 = 取消指派。**项目经理不可流转状态**（矩阵无客户侧流转行）——「修改/管理」= 字段编辑 + 指派，不含状态机推进。

## 评论

评论权限按矩阵：PM/KeyUser/内部可评论（普通用户 403，验收 ① 越权 403 测试覆盖）。详情响应内嵌评论（join users 带 authorName，删除用户 set null 显示「已删除」），不单独设列表端点——问题详情单请求拿全，demo 友好。

## 审计

AUDIT_ACTIONS 新增 `issue.create` / `issue.update` / `issue.transition`（from/to）/ `issue.comment`，成功才记录、请求事务内写入（与 #13/#14 同模式）。metadata 经 AuditService `JSON.stringify` 落 jsonb（postgres.js 读取为字符串，e2e 断言需 `JSON.parse`）。

## 已知取舍

- 问题关联蓝图/功能/文档（spec 42）未做——蓝图模块尚未交付，`related` 字段留待蓝图 ticket
- 列表无分页（Phase 1 量级小；量大时 limit/offset）
- 普通用户无评论入口（矩阵「—」），详情页按 viewerRole 隐藏表单
- 提交人详情未回显姓名（列表/详情只暴露 reporterId；成员表可 join，量小暂不做）
- web 无自动化 e2e（无 Playwright 基建），验收 ④「前端 e2e 可用」= 页面实现 + `pnpm build` + 后端 API e2e 全绿 + demo path 手动走通
