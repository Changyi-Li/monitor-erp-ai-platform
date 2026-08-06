# 0010: 文档 → RAG 同步（发布即同步：事务入队 + Worker + DocumentIndexPort 内存 fake）

Status: accepted

## 背景

#21 交付切片 11（spec §4.3「文档 → RAG 自动同步」）：**发布即同步（版本化）**——只有「已发布」进 RAG；发布 = 消息队列事务消息（入队失败则发布回滚）；同步 Worker 经 `DocumentIndexPort` 适配层异步导入、轮询状态、**幂等（平台文档 ID + 版本号）**、删除；失败指数退避重试；按文档 scope 路由（内部文档 → 内部 Index，项目文档 → 客户 Index）；同步状态可查询（spec 用户故事 50）。本切片以内存 fake 实现 `DocumentIndexPort` 验证管线，真实 RAG 平台（Dify/RagFlow/百炼）后续接入——**切换实现 = 改 `INDEX_DRIVER` 配置，业务代码零改动**（同 StoragePort/MQ 模式）。

## 触发模型：发布/归档/恢复 = 事务入队（持久化任务表），MQ 事件仅唤醒信号

**「事务入队」在内存 MQ 下的语义**：真实事务消息（RocketMQ 首选）由 broker 半消息保证；本实现 = **持久化任务表 `document_syncs` 行与发布动作同请求事务落库**（insert 失败 → 请求事务回滚 → 发布回滚，满足「入队失败则发布回滚」），事务提交后 `MessageQueuePort.publish('document.sync', {syncId})` 仅作**唤醒信号**——可丢失，Worker 定时扫 due（2s）兜底 + 启动即扫（进程重启后未完成任务）。MQ 事件早于事务可见时 Worker 抢单 0 行空转，由兜底消化——ADR 0008 预留的发布落点（kb publish/archive/restore）本期接入。

触发点（三处，均在 service 层单一落点）：
- `kb.service` publish → upsert internal scope（版本号 = 新版本）
- `kb.service` archive → delete（最后发布版本）→ **恢复 = upsert 重置重新导入**
- `blueprints.service` create（内联发布 v1）/ publish → upsert customer scope（tenantId 冗余）

## 数据模型：document_syncs = 持久化队列（幂等键 + 状态机 + 退避）

`document_syncs`（迁移 0011，RLS 双策略同 issues）：`documentId`（多态无 FK）+ `documentType` + `versionNumber` + `action`（upsert/delete）+ `scope`（internal/customer）+ `tenantId`（customer 冗余供 RLS）+ `title` 快照（调试台免多态 join）+ `status`（queued/processing/succeeded/failed）+ `attempt` + `nextRetryAt` + `lastError`。

- **幂等**：`unique(documentId, documentType, versionNumber, action)`——重复事件不重复导入；**「归档 → 恢复」场景**（同版本无新版本号）→ upsert 行已 succeeded 时**重置为 queued 重新导入**（updated_at 更新；worker 按「delete 优先、updated_at 升序」处理，保证 Index 先下架再重建，最终状态正确）
- **Worker 乐观抢单**：`UPDATE ... WHERE id AND status IN ('queued','failed')`——事件驱动与定时扫并发命中时仅一个成功（防重复导入）
- **指数退避**（spec 56）：失败 → `attempt+1` → `nextRetryAt = now + min(60, 2^attempt)` 秒（纯函数 `backoffDelayMs` 单测）；**重试上限 5 次**后 failed 留痕 + logger 告警（文档级同步状态/告警为 spec 后续增强）

## Worker 的数据库访问：内部上下文事务（复制 interceptor 模式）

DRIZZLE 代理无请求上下文时走 base 连接（RLS fail closed）→ Worker 经 `withInternalTx`（`RAW_DB.transaction` + `set_config('app.is_internal','true',true)` + `TenantContextService.run`，复制 tenant.interceptor 的 tx 模式）旁路 RLS 跨租户读写任务行/版本表。

## DocumentIndexPort：平台无关适配层（内存 fake 验证管线）

`apps/api/src/adapters/indexing/`：`DocumentIndexPort { upsert / remove / list }`——`IndexedDocument = {documentId, versionNumber, scope, title, content, contentType, updatedAt}`；内存 fake 按 scope 分 Map + **`failNextUpsertOnce()` 调试开关**（调试台「制造一次失败」演示指数退避重试）。内容提取：kb markdown → 正文原文；kb 文件类 → 元信息文本（真实解析为平台接入增强）；蓝图 → 4 结构化字段 + drawio 文件名拼接。**scope 路由**（spec 57）：kb（全局）→ internal；蓝图（客户项目文档）→ customer。

## 权限：新增 rag:view（仅内部）

权限矩阵无 RAG 行 → 新增权限点 `rag:view`（super_admin/internal，#15 issue:transition 新增权限点先例）；RAG 端点全局（无项目上下文，`can(actor.role, 'rag:view')` 直接断言）。`GET /rag/syncs`（状态面板，status/scope 筛选）、`GET /rag/index?scope=`（fake Index 可见性）、`POST /rag/debug/fail-next`（调试注入）。同步行不审计（系统行为，量级大；审计仍覆盖用户动作 kb.publish/blueprint.publish）。

## 已知取舍

- 「事务入队」= 任务行同事务落库 + MQ 事件仅唤醒（真实事务消息由 broker 保证；接缝 = MessageQueuePort 不变）
- 文件类 kb 文档只索引元信息（正文解析随真实平台接入）；蓝图内容 = 字段拼接文本（drawio 本体解析同）
- 会议纪要无发布动作（创建即生效、无版本化）→ 不接入（spec「只有已发布进 RAG」）；蓝图无归档/删除端点 → 无 delete 源
- worker 轮询 2s（开发量级非生产节流）；重试上限 5 次后 failed 留痕（告警/文档级同步状态为后续增强）
- fake Index 进程内（重启即空——真实平台接入后由平台持久化）；调试注入端点仅 memory 驱动有效（真实平台返回 armed: false）
- web 无自动化 e2e（无 Playwright 基建），验收④ = 页面实现 + `pnpm build` + 后端 e2e 全绿（同 #15–#20 模式）
