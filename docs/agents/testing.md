# 测试策略（速度分层）

> 原则：**默认轻量，提交前全量**。改动几分钟的活不要扛 20 分钟测试。

## 分层（按改动面选档）

| 档位 | 命令 | 耗时 | 何时 |
|---|---|---|---|
| 1 单元 | `pnpm test`（vitest，全工作区单测/契约） | ~1 分钟 | **每次改动必跑**；纯前端/纯 schema 改动到此为止 |
| 2 受影响的 e2e | `pnpm --filter @monitor/api exec vitest run --config vitest.e2e.config.ts test/<spec>.e2e-spec.ts [<相邻spec>...]` | 每条 ~1-2 分钟 | 改动某模块 API 时跑该模块 spec + 兄弟 spec（如 /users 权限 → rbac + user-profile + customer-invite） |
| 3 全量 e2e | `pnpm --filter @monitor/api test:e2e` | ~6 分钟 | **只在提交/推送前**，或改动波及守卫/拦截器/认证/租户/迁移等共享面时 |

## e2e 为什么快（本仓库已做的工作）

- **`isolate: false`**（vitest.e2e.config.ts）：单 worker 内所有 spec 共享模块注册表，Nest 依赖图只 import 一次（原来每文件重 import，21 文件 ≈ 7-13 分钟纯 import 开销）
- **`PASSWORD_HASH_ROUNDS=4`**（.env.test，示例见 tracked 的 `.env.test.example`）：测试环境 bcrypt 4 轮 ≈50ms/次（原来 12 轮纯 JS ≈2.5s/次，密码哈希是测试时间大头）；生产默认 12 轮不变
- `fileParallelism: false` + 每文件 `resetTestDb()` 清库：spec 相互独立，可安全单文件跑

## 安全边界

- 改动认证/RBAC 语义时，**必须**连带检查兄弟 spec 的旧断言（例：resend 权限放开时 user-profile.e2e-spec 的 403 断言需要同步更新——全量抓到的真实案例）
- e2e 只连 `monitor_erp_test`（setup-test-db 硬校验）；`PASSWORD_HASH_ROUNDS` 只允许 4-15，测试强度仍走真实 bcrypt 路径
