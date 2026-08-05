# Monitor ERP AI Platform

Monitor ERP 项目实施管理平台。全栈 TypeScript monorepo（Turborepo + pnpm workspaces）。

## 结构

```
apps/
  web/          # Next.js 16 前端（App Router）
  api/          # NestJS 11 后端（Fastify 适配器 + Drizzle ORM）
packages/
  shared/       # 共享常量与类型
  contracts/    # API 契约（zod schemas，前后端共用校验）
```

## 快速开始

前置：Node.js 24、pnpm 11、PostgreSQL 13+（开发机为 18）。

```bash
# 1. 安装依赖
pnpm install

# 2. 配置环境变量（apps/api/.env 从 .env.example 复制，填数据库密码与 JWT_SECRET）
#    DATABASE_URL=postgres://postgres:<password>@localhost:5432/monitor_erp
#    JWT_SECRET=<node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))">

# 3. 建库并应用迁移
#    psql 创建 monitor_erp 与 monitor_erp_test 两个库后：
pnpm db:migrate

# 4. 启动双服务（web:3000 / api:3001）
pnpm dev
```

浏览器打开 http://localhost:3000 → 注册 → 登录 → 右上角显示当前用户 → 登出。
前端 `/api/*` 经 Next.js rewrites 同源代理到后端，无跨域配置。

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm build` | 全仓构建（shared → contracts → api/web） |
| `pnpm dev` | 双服务并行开发 |
| `pnpm test` | 契约测试 + 单元测试 |
| `pnpm test:e2e` | API e2e（真实 PostgreSQL 测试库 `monitor_erp_test`） |
| `pnpm db:generate` / `pnpm db:migrate` | Drizzle 迁移生成 / 应用 |

## 认证设计（骨架期）

- 注册（开放）/ 登录 / 登出 / me / refresh（轮换式，旧 token 刷新即失效）
- 短时 JWT Access Token + 存库 Refresh Token（sha256，登出删行 = 登出生效）
- 请求与响应均经 `packages/contracts` 的 zod 契约校验（ZodValidationPipe / ZodResponseInterceptor / 前端 apiFetch）
- 安全备忘（后续 issue 加固）：register 开放、access token 存 localStorage、refresh token 明文仅走 HTTPS 链路；生产化方向：管理员建号/邀请流、Redis 会话、httpOnly cookie、RLS
