# 0001: 多租户数据隔离 — 共享 schema + 客户级 RLS + 每请求事务 SET LOCAL

Status: accepted

多租户 SaaS（数千+客户）的数据隔离红线选择数据库层 RLS 兜底（spec §7.1/§7.3）：共享 schema，业务表带 `tenant_id`（客户级），Drizzle `pgPolicy` 写在 schema 内随迁移同一单元管理（杜绝策略漂移）。策略为 permissive 两条——租户隔离（`tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`）与内部旁路（`app.is_internal = 'true'`），**两条都带 `withCheck`**（旁路策略缺 withCheck 时客户角色 INSERT 可绕过租户约束写任意 tenant_id）。`::uuid` cast 必需（GUC 是 text）；**`NULLIF` 归一空串必需**——PG 怪癖：从未在会话级设置的自定义 GUC 经 `SET LOCAL` 提交后会话值残留 `''`（非 NULL），`''::uuid` 会 22P02 报 500（e2e 实测复现），NULLIF 使其与未设置同样 fail closed；内部请求绝不设置 `app.tenant_id`。不可见统一返回 404 而非 403，不暴露资源存在性。

GUC 经 **每请求事务内 `SET LOCAL`** 注入（TenantInterceptor 开事务 → set_config → AsyncLocalStorage + DRIZZLE 代理把 handler 查询转发到 tx 客户端），事务结束自动失效——绝不使用会话级 SET，规避连接池会话变量泄漏（tech-stack-typescript.md §7 明示的坑）。应用连接使用受限角色 `app_tenant_user`（迁移创建，非表 owner、无 BYPASSRLS），**表 owner 默认绕过 RLS，因此应用/测试连接必须用受限角色**（`.env.test` 的 DATABASE_URL 即此角色）；owner 连接（`DATABASE_OWNER_URL`）仅迁移/管理/seed 使用，生产不配置。受限角色密码经 `ALTER ROLE ... LOGIN PASSWORD` 外置设置（测试在 setup 做，生产走部署文档），不落迁移文件。GRANT 由迁移手写追加（drizzle-kit 不生成）：表级 CRUD + `ALTER DEFAULT PRIVILEGES` 覆盖未来表；不给 REFERENCES（FK 检查以表 owner 身份执行、绕过 RLS）、TRUNCATE（仅管理）与 CONNECT（PUBLIC 默认有）。

项目边界（客户用户按项目成员关系授权）在**应用层**执行（ProjectsService 显式按租户过滤），RLS 是数据库层兜底——即使应用层漏过滤，受限连接也查不到他租户的行。`users`/`refresh_tokens`/`user_tenants` 为平台级表，刻意不加 RLS（认证流程与租户解析依赖）。JWT AccessToken 增加 `role` 声明供租户上下文判定内部/客户；旧 token 无此声明按 internal 处理（短 TTL 缓解，强制重新登录即可）。多客户用户本期取第一个成员关系（`limit 1`），显式租户切换留后续 ticket。不启用 `FORCE ROW LEVEL SECURITY`（会破坏 owner 管理路径）。
