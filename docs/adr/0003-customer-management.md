# 0003: 客户资料维护边界与搜索

Status: accepted

## 背景

#13 已交付客户注册（超管专属）、项目归属（内部+）与租户级 RLS。本期（#14）补齐客户资料管理链路：内部用户编辑客户资料（名称/行业/地域）、搜索全部客户；客户用户只读查看所属客户资料。**零数据模型改动**——`customers.industry`/`region` 列在 0001 迁移即存在，#13 建客户接口已支持，本期只新增读写链路。

## 编辑权限：内部+，客户 403

`PATCH /api/customers/:id` 标注 `@Roles('super_admin', 'internal')`，客户角色由 RolesGuard 直接 403——客户用户永远到不了 service 层。权限矩阵（`packages/shared/src/permissions.ts`）新增 `customer:update`（super_admin/internal ✓）保持唯一事实源。PATCH 语义：部分更新，`undefined` 不动、`null` 清空（industry/region 可显式清空）、空对象 = 无操作（短路返回，避免 `set({})` 生成非法 SQL）。先查后改：行不存在 → 404；uuid 非法由 controller 的 `ZodValidationPipe(z.uuid())` 挡 400（与 projects 同款，避免 22P02 → 500）。

## 列表放开：客户只见所属（RLS 过滤），不建 /me

`GET /api/customers` 从「内部+」放开为「所有登录角色」（显式 `@Roles('super_admin','internal','customer')`，不靠 RolesGuard 无 metadata 放行——自文档化）。客户用户查列表即"查看所属客户资料"（验收 ③）：租户级 RLS（0001 的 `customers_tenant_self` 策略）天然过滤到自己的客户行，**应用层零客户过滤代码**，无 `/customers/me` 新端点。只读边界 = RolesGuard 挡 PATCH + 前端按 `isPlatformRole()` 隐藏编辑入口。

## 搜索

`GET /api/customers?search=` 对 name/industry/region 三列 `ILIKE '%kw%'`（OR），通配符 `%`/`_`/`\` 先转义（Postgres ILIKE 默认 escape 为反斜杠），防用户输入当模式。空 search = 全量。搜索对客户角色同样生效但被 RLS 缩小到一行——无害。

## 项目归属不可变更

**平台不提供任何修改 `projects.tenant_id` 的端点**（验收 ④ 允许"或无此功能"）。数据层双重兜底：FK `projects.tenant_id → customers.id` 保证 1:N；RLS `withCheck`（`projects_tenant_isolation`）使客户角色即使绕过应用层也无法把项目改挂到其他客户。未来若需"迁移项目到新客户"，应新建专用端点 + 审计动作 + 前端二次确认，不开放通用 PATCH。

## 审计

`AUDIT_ACTIONS.CUSTOMER_UPDATE`（成功才记录，请求事务内写入——与 #13 审计模式一致）：actor（userId/role）、resource（customer id）、metadata（变更后 name）。读操作（列表/搜索）不审计防噪音（与 `project.read` 仅详情同理由）。

## 已知取舍

- 客户用户能枚举到列表端点存在（200 空或一行），但 RLS 使其无法探测其他客户（跨租户内容不可见，与 #12 404 语义一致——此处 200 但空/单行同样不泄露内容）
- 搜索未做分页（Phase 1 客户量级小；量大时加 limit/offset 即可）
- 无客户资料必填校验增强（行业/地域均为可选，spec 未要求）
