# 0011: 内部客服 AI Agent（LangGraph.js 真实编排 + LLMClient memory fake + 检索注入 + 引用溯源）

Status: accepted

## 背景

#22 交付切片 12（spec §5「内部客服 AI Agent」）：**LangGraph.js 图**（检索/生成/引用解析节点）真实引入；**LLMClient 抽象门面**（本期仅 memory fake 确定性输出，计量与多模型在切片 13/14）；**检索范围后端注入**（内部 KB + 所有客户 Index，仅内部用户）；**会话 checkpoint 数据库持久化**（多轮记忆、回看/继续）；**引用溯源**（回答带 [n] 角标，点击跳转知识库原文）；独立 AI 客服页面 + 悬浮小组件。

## LangGraph.js 真实引入（用户定稿技术栈；镜像源安装）

`@langchain/langgraph@1.4.9`（npmmirror 镜像安装）+ peer `@langchain/core`（均无 postinstall，allowBuilds 白名单不拦）。**1.x API 与训练数据差异大**——实施第一步读包内 .d.ts 确认：`BaseCheckpointSaver`（langgraph-checkpoint 1.1.3）抽象方法为 `getTuple / list(AsyncGenerator) / put(config, checkpoint, metadata, newVersions) / putWrites / deleteThread`；`invoke` 第二参数是 PregelOptions（extends RunnableConfig，`configurable.thread_id` 直接顶层，**不是 0.2.x 的嵌套 config**）；`Annotation` 必须带 reducer（`{default}` 单独不合法）；`PendingWrite` 未从 langgraph re-export。图 = 3 节点线性（retrieve → generate → resolveCitations），`compile({checkpointer})`。

## checkpoint 持久化（DrizzleCheckpointSaver，接缝 = BaseCheckpointSaver）

- 表：`langgraph_checkpoints`（threadId/checkpointId text——LangGraph uuid6 不能落 uuid 列/parentCheckpointId/checkpoint jsonb/metadata jsonb）+ `langgraph_checkpoint_writes`（putWrites 的 [taskId, channel, value] 三元组；线性图多为空但接口须实现）
- **序列化走 `this.serde`（JsonPlusSerializer）**：`dumpsTyped` → ["json", Uint8Array] → UTF-8 解码存 jsonb，读回 `loadsTyped('json', string)` 还原——不手写 JSON 直存直读（消息对象往返由 serde 保证）
- `put` UPSERT 幂等重放（langgraph 重试/重放重复 put 同 checkpoint_id）；`putWrites` idx = 数组序
- **只经 DRIZZLE 代理**：请求上下文内自动进请求事务（与 ai_messages 双写原子）；无上下文 RLS fail closed——单测/后台必须包 `withInternalTx`（复用 rag-sync.service 模式）

## LLMClient 门面（仅 memory fake；切片 13/14 接真实 OpenAI 兼容驱动）

`adapters/llm/`（复制 IDX/STORAGE/MQ 的 @Global + Symbol + driver 工厂模式）：`LLMClient { chat({messages}) }` + `MemoryLlmAdapter` 确定性规则（从 prompt 的 `[检索文档]`/`[历史对话]` 区块解析；回答 = 「根据知识库《top》：摘要…[1]」；追问词「引用/来源」→ 复述上一轮问题，证明多轮记忆；无检索 → 抱歉）。切换真实供应商 = 改 `LLM_DRIVER` 配置 + 扩 enum，业务零改动。

## 检索范围注入与引用溯源

- **`DocumentIndexPort.search(query, scopes, limit)` 新增**（memory 实现：去标点切词 + 2-4 字 n-gram 窗口打分，title ×3 / content ×1；真实平台 = 多库联合检索接缝）。范围 = `['internal','customer']` 后端硬编码（spec 内部 Agent 全量；Phase 2 客户 Agent 只改一处）。防泄漏红线：检索只发生在服务端，客户用户连端点都到不了（403）
- **引用路由**：`IndexedDocument` + `documentType?`/`projectId?`（#21 buildEntry 蓝图分支 join blueprints 取 projectId；`listIndex` DTO 手动映射不动 → #21 契约零影响）；web 端 `citationUrl`：kb → `/kb/{id}`，blueprint → `/projects/{projectId}/blueprints`（projectId 缺失退化为无链接）
- **resolveCitations 节点**：正则抽 answer 中 `[n]` → 映射检索结果（只保留被引用的）→ citations 契约

## SSE 流式：「算完回放」式（事务边界取舍）

POST messages → SSE（`reply.hijack()` + `raw.writeHead`，不引入 @fastify/sse；端点**不标 @ZodResponse**——ZodResponseInterceptor 会 safeParse handler 返回值）。时序：断言/归属 404 → `graph.invoke`（**请求事务内**：checkpointer 写 + ai_messages user/assistant 行 + 首轮 title 快照，原子）→ 审计 `agent.chat` → hijack 写 `event: citations → token*（6 字/10ms 分块）→ done`。hijack 前抛错 = 正常 4xx/5xx + 回滚；hijack 后无 DB 操作，无 mid-stream 错误面。**真 token 流（切片 13/14）需把 invoke 移出请求事务 + LLM 流式通道——事件协议（citations/token/done）已预留兼容**。

## 权限与会话归属

- `agent:use` 权限点**已在矩阵**（super_admin/internal，#19 预留）——零改动，service 层 `can()` 断言（assertAgentUse，同 assertRagView 模式）；客户 403
- 会话归属 = 用户本人：RLS 单策略 `internal_bypass`（客户 0 行 fail closed）+ **应用层 `userId = actor.sub` 过滤**（内部用户互不可见，RLS 拦不住同角色水平越权）；他人会话 → 404 防探测

## 数据模型

`ai_conversations`（userId ref cascade、title 首问前 20 字快照）+ `ai_messages`（role check、citations jsonb）——**业务投影表**：checkpointer 是 agent 运行时记忆事实源，ai_messages 是展示/审计投影（回看 API 一条 SQL、契约稳定），同请求事务双写原子（分歧仅存于 interrupt/fork，本图无）。迁移 0012。

## 已知取舍

- 「算完回放」式 SSE（fake 毫秒级可接受；真 token 流切片 13/14，事件协议不变）
- memory 检索 = 关键词 n-gram 打分 + fake LLM 确定性回答（真实 LLM/检索在切片 13/14 接）
- 引用跳转为页面级（web markdown 渲染器 escape-first 无 heading id；锚点级为可选增强）；回答按 `[n]` 正则切分插角标，不走 markdown 渲染
- 检索范围硬编码全量；fake 阶段客户文档同 'customer' Map（真实平台按客户分 Index 后 search 接缝不变）
- 会话只读审计（agent.chat 每次提问）；AI 消息体本身不落审计（量级大，checkpoint + ai_messages 已是事实源）
- web 无自动化 e2e（无 Playwright 基建），验收④ = 页面实现 + `pnpm build` + 后端 e2e 全绿（同 #15–#21 模式）
