# 调研：Monitor ERP 项目实施管理平台 — 全栈 TypeScript 技术栈（最终定稿）

> 状态：**当前有效**（2026-08-04 用户定稿，替代 `tech-stack.md` 与 `phase1-spec.md` 中的旧技术栈）。
> 背景：项目决定**全栈使用 TypeScript**（前端与后端同语言），取代原先"Next.js 前端 + Python FastAPI 后端"的混合栈。
> 本调研基于官方文档/一手资料 + 工程判断，覆盖四个决策点：后端框架、ORM（重点：RLS 多租户）、Monorepo 结构、Agent 编排。

---

## 1. TL;DR（最终定稿一览）

| 决策点 | 定稿（Final） | 备选 |
|---|---|---|
| 后端框架 | **NestJS**（TypeScript，Fastify 适配器） | Fastify / Hono |
| ORM / 数据访问 | **Drizzle**（schema 内原生 `pgPolicy` / `pgRole` 管理 RLS） | Prisma / TypeORM |
| 工程结构 | **Turborepo + pnpm workspaces**（monorepo） | Nx / 纯 pnpm |
| Agent 编排 | **LangGraph.js**（v1.0，图编排 + checkpoint） | Vercel AI SDK |
| 前端 | Next.js + React + TypeScript + shadcn/ui（沿用原定稿） | Ant Design / MUI |

完整技术栈（含数据层/消息/缓存等，沿用原 spec §8.1）见 `docs/specs/phase1-spec.md` §8。

---

## 2. 决策一：后端框架 — NestJS（Fastify 适配器）

### 候选对比（2026 现状）

| 维度 | **NestJS** v11 | **Fastify** v5 | **Hono** v4.12 |
|---|---|---|---|
| 周下载量 | ~9.1M | ~6.7M | ~34.5M |
| 定位 | 企业级重框架（Angular 风格：模块/DI/守卫/拦截器/管道） | 轻量插件化 | 极轻量，Web 标准，edge 原生 |
| 运行时 | 仅 Node（Express/Fastify 适配器） | 仅 Node | Node/Bun/Deno/CF Workers 全支持 |
| 性能（简单 JSON） | 18k–28k（Express）/ 45k–55k（Fastify 适配器） | 45k–65k | ~70k（Node）/ ~200k（Worker） |
| 校验 | class-validator DTO | JSON Schema（Typebox） | zod-validator |
| 生态 | **最全**（@nestjs/passport、bull、schedule、graphql、cache、microservices） | @fastify/* 成熟 | @hono/* 较小 |
| 测试 | @nestjs/testing（DI 感知 mock） | `.inject()` | `app.request()` |

### 决策理由

1. **ERP 复杂度需要架构约束**：本项目是 Auth/RBAC、租户上下文、审计、多服务域、消息队列消费、定时任务并存的复杂业务系统。NestJS 的模块边界 + 依赖注入 + 守卫/拦截器管线提供了长期可维护性（与当初选 Spring Boot 的考量一致）。
2. **生态匹配度高**：认证（passport/jwt）、队列（@nestjs/bull 对接 RocketMQ/Redis）、定时任务（@nestjs/schedule）都有第一方/成熟模块，减少自建。
3. **性能问题用适配器规避**：NestJS 走 **Fastify 适配器**（45k–55k req/s），真实业务下与原生 Fastify 差距收窄，对数千租户绰绰有余。
4. Hono 的最大卖点是 edge/serverless（本项目 ECS/ACK 单体部署用不上）；Fastify 轻但结构自律要求高。

---

## 3. 决策二：ORM — Drizzle（RLS 是第一差异点）

> 本项目数据隔离红线 = **数据库层 RLS 兜底**（spec §7.3），因此 RLS 支持方式是选型第一差异点。

### 候选对比

| 维度 | **Drizzle** | **Prisma** | **TypeORM** |
|---|---|---|---|
| Schema 形态 | 纯 TS 文件，无 codegen | 自定义 DSL + `prisma generate` | 装饰器实体类 |
| **RLS 支持** | **原生一等公民**：drizzle-kit 0.27+ 在 schema 内定义 `pgRole`/`pgPolicy`（`USING` 写 `current_setting('app.tenant_id')`），策略与表结构**同一迁移单元** | Client Extension + 手写 SQL 迁移（官方示例标注"仅示例需加固"），策略易漂移 | 无官方模式 |
| 迁移安全 | SQL 透明可见，守护较少 | **最成熟**（数据丢失检测/advisory lock/drift detection） | 一般 |
| 关系查询 | SQL 原生（大查询较啰嗦） | `include` 嵌套最简洁 | 传统 |
| 采用趋势 | 下载量 2025 末超 Prisma；PlanetScale 2026.3 收购核心团队 | 稳定最大生态（Studio/Accelerate） | 热度下降 |

### Drizzle 原生 RLS 示例（将用于本项目）

```ts
import { sql } from 'drizzle-orm';
import { pgPolicy, pgRole, pgTable, uuid } from 'drizzle-orm/pg-core';

export const appTenantRole = pgRole('app_tenant_user'); // 受限角色（非表 owner、无 BYPASSRLS）

export const issues = pgTable('issues', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  // ... 其余字段
}, (t) => [
  pgPolicy('tenant_isolation', {
    as: 'permissive',
    to: appTenantRole,
    using: sql`${t.tenantId} = current_setting('app.tenant_id', true)`,
  }),
]);
```

服务层在事务内执行 `SELECT set_config('app.tenant_id', ?, true)`（`SET LOCAL`），后续查询自动被 RLS 约束；内部用户连接走旁路策略（`app.is_internal=true` 可见全部）。

### 决策理由

1. **RLS 策略与表结构同迁移单元**：策略写进 schema、随 drizzle-kit 一起迁移，杜绝"表结构升了、策略忘了"的漂移——直接服务数据隔离红线。
2. **无 codegen**：纯 TS schema 与全栈 TS 工程天然一体，无生成物过期问题。
3. **性能/体积最轻**（~5–7KB），SQL 透明可预测。
4. 代价（迁移守护较少、复杂关系查询啰嗦）以工程纪律 + 代码评审覆盖；项目起步阶段 schema 演进可控。
5. 若未来迁移安全诉求升级，可引入 Atlas（支持 Prisma/Drizzle schema 与 RLS 策略统一管理）。

---

## 4. 决策三：Monorepo — Turborepo + pnpm workspaces

### 候选对比

| 维度 | **Turborepo** | **Nx** | 纯 pnpm workspaces |
|---|---|---|---|
| 定位 | 轻量任务编排（Rust 内核） | 重量级平台（generator/graph/治理） | 仅依赖管理 |
| 学习曲线 | 低 | 中高 | 最低 |
| 增量构建/缓存 | 本地+远程（Vercel） | 本地+远程+分布式 | 无 |
| 受影响构建 | 有 | 更强（`nx affected`） | 无 |
| 架构边界治理 | 弱 | 强（lint 规则） | 无 |
| 版本发布 | 配 Changesets | 内建 | 自配 |

### 决策理由

1. **规模匹配**：2 个 app（`apps/web` + `apps/api`）+ 共享包（`packages/shared` 类型/DTO、`packages/contracts` zod 契约），Turborepo 的轻量缓存编排正合适；Nx 的生成器/边界治理对当前团队规模是过度设计。
2. **与 Next.js/Vercel 同生态**，远程缓存、部署链路顺滑。
3. pnpm 严格依赖管理（`workspace:*` 协议）保证本地代码本地解析。

### 预期结构

```
monitor-erp-ai-platform/
├── apps/
│   ├── web/            # Next.js（前端）
│   └── api/            # NestJS（后端）
├── packages/
│   ├── shared/         # 共享类型 / DTO / 常量
│   └── contracts/      # API 契约（zod schemas，前后端共用校验）
├── turbo.json
└── pnpm-workspace.yaml
```

---

## 5. 决策四：Agent 编排 — LangGraph.js

> 原 spec 已定"平台自研 Agent 编排（LangGraph）"，全栈 TS 后自然对应 **LangGraph.js**（同一框架的 TS 实现）。

### 候选对比

| 维度 | **LangGraph.js** v1.0 | **Vercel AI SDK** v6/v7 |
|---|---|---|
| 定位 | 图编排，有状态生产级 Agent | UI-first 轻量 AI 工具包 |
| 持久状态/checkpoint | **一等公民**（checkpointer、崩溃恢复） | v7（2026.6）才新增 WorkflowAgent |
| Human-in-the-loop | **一等公民**（interrupt 审校） | 无内建 |
| 多 Agent/并行分支 | 原生 | 无 |
| 与 Next.js 集成 | 一般（自接流式） | 原生最强（useChat） |
| 生产背书 | Uber/JPMorgan/BlackRock/Klarna 等 | 最大 TS 安装基数 |

### 决策理由

spec §5 的硬性需求——**checkpoint 持久化会话、多轮记忆、可回看/继续、HITL 逐章审校**（操作手册生成）——与 LangGraph.js 的能力一一对应；Vercel AI SDK 的流式 UI 虽好，但持久化/审校是短板。注意：LangSmith/LangGraph Platform 为付费托管，本项目只用开源核心（图编排 + Checkpointer），自带 PostgreSQL checkpointer。

---

## 6. 与既有决策的一致性

| 原定稿 | 新定稿 | 变化 |
|---|---|---|
| 前端 Next.js + React + shadcn/ui | 不变 | — |
| 后端 Python + FastAPI | **NestJS + Drizzle** | 全栈 TS |
| ORM SQLAlchemy + Alembic | **Drizzle + drizzle-kit** | 全栈 TS + 原生 RLS 管理 |
| Agent 编排 LangGraph（Python） | **LangGraph.js** | 同框架 TS 实现 |
| 数据库 PG + RLS（池模型） | 不变 | — |
| S3 兼容 / RocketMQ / Redis / LLMClient 门面 / DocumentIndexPort 适配层 | 不变 | 平台无关决策不受影响 |

**不受影响的既有决策**：数据库（PostgreSQL + RLS）、对象存储（S3 兼容）、消息队列（可替换，事务消息）、缓存（Redis）、RAG 平台适配（`DocumentIndexPort`，候选 Dify/RagFlow/百炼）、多租户隔离模型（§7）、LLM 抽象（`LLMClient` 门面）——这些决策与语言无关，无需重开。

---

## 7. 风险与开放问题

1. **NestJS + Drizzle 生态磨合**：Drizzle 非 NestJS 第一方集成，需自行封装模块（`DrizzleModule.forRoot()` + 租户上下文 Provider），工程量可控但需在 Phase 1 早期定型。
2. **RLS 与连接池**：`SET LOCAL` 必须在事务内执行，注意 pg 连接池复用会话变量的坑（事务级设置 + 每请求开事务）。
3. **LangGraph.js checkpoint 持久化**：PostgreSQL checkpointer（langgraph-checkpoint-postgres）需在 NestJS 内集成，涉及迁移表管理。
4. **LangGraph.js 版本演进**：v1.0 为 2026 新里程碑，生态（LangSmith 等）付费功能取舍需明确——本项目只用开源核心。

---

## 8. 来源（Sources）

**后端框架**
- NestJS vs Fastify vs Hono（2026 对比）：https://encore.dev/articles/nestjs-vs-fastify-vs-hono
- Best TypeScript Backend Frameworks 2026：https://encore.dev/articles/best-typescript-backend-frameworks
- Top Node.js Frameworks 2026（NestJS/Fastify/Express）：https://ortemtech.com/blog/top-nodejs-frameworks-2026/
- Hono vs Fastify vs NestJS（2026）：https://www.pkgpulse.com/guides/hono-vs-fastify-vs-nestjs-2026

**ORM 与 RLS**
- Prisma vs Drizzle（Vercel 官方对比）：https://vercel.com/i/prisma-vs-drizzle-orms
- Drizzle ORM vs Prisma（2026，Bytebase）：https://www.bytebase.com/blog/drizzle-vs-prisma/
- Drizzle ORM 官方 RLS 文档：https://orm.drizzle.team/docs/rls
- drizzle-kit 0.27.0（原生 RLS 支持）：https://github.com/drizzle-team/drizzle-orm/releases/tag/drizzle-kit%400.27.0
- Prisma 官方 RLS Client Extension 示例：https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security
- 用 Prisma 实现 RLS（Atlas 指南）：https://atlasgo.io/guides/orms/prisma/row-level-security

**Monorepo**
- Turborepo（Thoughtworks Technology Radar）：https://www.thoughtworks.com/zh-cn/radar/tools/turborepo
- Monorepo 架构指南 2025（Feature-Sliced Design）：https://feature-sliced.design/blog/frontend-monorepo-explained

**Agent 编排**
- LangGraph vs Vercel AI SDK（2026）：https://www.respan.ai/market-map/compare/langgraph-vs-vercel-ai-sdk
- Vercel AI SDK Alternatives 2026：https://futureagi.com/blog/vercel-ai-sdk-alternatives-2026/
- Best AI Agent Frameworks 2026（AgentMail）：https://www.agentmail.to/blog/best-ai-agent-frameworks-2026
