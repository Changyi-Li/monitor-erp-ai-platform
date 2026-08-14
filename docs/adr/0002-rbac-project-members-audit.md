# 0002: RBAC、项目成员边界与审计日志

Status: accepted

## 角色模型

平台粗粒度角色 `USER_ROLES = ['super_admin','internal','customer']` 走 JWT（`TenantInterceptor` 的 `role !== 'customer'` 内部旁路判定不变）；客户侧细粒度角色（项目经理 / Key User / 普通用户）**不存 users.role、不进 JWT**，按项目存 `project_members.role`（spec §2.1「项目成员 = 用户 + 项目 + 角色」）。`super_admin` = 内部全权限 + 平台管理（`RolesGuard` 中 `super_admin ⊇ internal`，单测断言）。权限矩阵（`packages/shared/src/permissions.ts`）为唯一事实源：14 项权限 × 5 功能角色（spec §2.4 十项 + 本期强制的基础设施权限 `project:create`/`member:manage`/`user:manage`/`customer:create`），后续模块直接复用 `can()`。

## 两层边界

- **租户隔离**（ADR-0001）：DB 层 RLS，客户级。跨租户 → 404（防存在性探测）。
- **项目边界**（本期）：应用层，客户用户只见 active 成员项目。同租户非成员 → **403**（跨项目访问），同租户成员 → 200。

403 vs 404 判定在 service 层同址完成（租户行查找 404 → 成员解析 403），不拆到 guard——**Nest guard 在 TenantInterceptor 之前运行**，guard 内查库会落在租户事务外（DRIZZLE 代理无 ALS 上下文回退 base）且与服务重复查询。因此项目级权限全部走 `MembersService.resolveViewerRole()`（请求事务内、受限角色连接、RLS 兜底同租户）；`RolesGuard` 只做纯 JWT 的平台粗粒度检查（零 DB）。

## 成员与邀请

唯一建号入口 `POST /api/projects/:id/members`：内部可授任一项目角色；客户 PM 只能授 `key_user`/`regular_user`（**不可升级角色/不可建 PM**，e2e 断言 403）。邀请 token：`randomBytes(32).base64url` → 落库 sha256（与 refresh token 同模式，`token-hash.ts`），7 天过期、一次性（设密后清空）。无邮件基础设施，`inviteUrl = ${WEB_URL}/invite?token=...` 由 API 直接返回创建者，部署接入 SMTP 后改为邮件发送（接口不变）。invited 用户 `isActive=false` + 占位密码哈希（不可登录）；设密后激活。跨租户成员关系不支持（interceptor 取第一个 `user_tenants`，ADR-0001）——邀请已有他租户用户 → 409。

## 停用语义

PM 停用只翻 `project_members.is_active`（用户可能在其他项目 active）；**不碰 `users.is_active`**（账号级停用归内部管理，本期未做端点）。停用后该用户对项目的访问立即失效（每请求解析成员表），旧 access token ≤15m TTL 自愈；refresh 不受影响（`users.is_active` 未动）。PM 只能停用 `key_user`/`regular_user` 成员（不能停 PM/自己）；内部全权。

## 审计

`audit_logs` 无 RLS（平台级；0001 的 `ALTER DEFAULT PRIVILEGES` 自动覆盖新表授权）。`AuditService.record()` 经 DRIZZLE 代理写入：受保护路由在请求事务内（权限变更与审计原子一致，响应契约失败整体回滚）；`@Public` 路由（login/set-password）无事务上下文走 base 客户端。IP 经 `TenantContext.ip`（ALS）注入，@Public 由 controller 显式传 `req.ip`。动作：登录成功/失败（失败记 `actor_role='anonymous'` + 邮箱，防枚举不冲突）、邀请设密、权限变更（建客户/建项目/加成员/停用启用）、关键数据访问（`project.read` 仅详情，列表不做防噪音）。

## 邀请设密与开放注册

开放 register **保留**（内部用户测试用，README 安全备忘待加固）。邀请设施（users 邀请字段、`set-password` 端点、成员表）本期全量建成，未来切换邀请模式 = 删 register 端点 + 前端注册入口，服务/表/矩阵零改动。

## 已知取舍

- 停用项目的旧 access token 最多存活 15m（JWT_ACCESS_TTL）
- 邀请链接明文出现在 URL/代理日志（一次性 + 7 天过期缓解；后续加固可加短期 PIN/二次验证）
- 内部组织标签（实施/开发/售后/市场/销售）Phase 1 功能权限相同，未落字段（需要时加 `org_label` 即可）
- `GET /api/projects/:id` 返回 `viewerRole` 供前端显隐管理入口；成员列表/管理仅内部或该项目 PM 可见

## 修订：T1/T2 角色模型合并为平台角色（superseded 上述「角色模型」段）

客户细粒度角色不再存 `project_members.role`（migration 0020 DROP COLUMN + check），并入平台角色：`USER_ROLES = ['super_admin','internal','customer_pm','customer_key_user','customer_user']`，随 JWT 签发，权限判定（`can()` 矩阵、`TenantInterceptor.isInternal`、各 service 的 viewerRole 解析）完全基于平台角色。项目成员表只存 `is_active` 成员关系；`viewerRole = users.role`（join projectMembers+users）。邀请入参角色收窄为 `customer_key_user|customer_user`（新账号即获对应平台角色；PM 档由超管调整）。成员管理权 `member:manage = ['super_admin','internal','customer_pm']`（客户 PM 可在自己项目内邀请/取消/停用，旧约束「PM 只能授 key_user/regular_user」「不能停 PM/自己」按平台角色重述：不能停 `customer_pm` 成员）。
