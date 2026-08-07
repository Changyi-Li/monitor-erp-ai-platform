# 0014: Online help 导入（双通道 → 暂存队列 → 只读文档 → 人工发布进 RAG）

Status: accepted

## 背景

#25 交付 spec §4.4「Online help 导入」：外部项目（合作伙伴/供应商的联机帮助中心）的知识文档**不入库 MR 审批流**，由两条通道进入内部知识库（kb）：**① 导入 API（外部系统主动推送）** + **② 定时拉取（平台按配置定时 HTTP 拉取外部清单）**。导入文档**只读**（不可在线编辑，内容只能由导入通道更新），**发布策略 = 先落草稿待人工发布**——内部用户人工发布后才复用 #21 管线（ADR 0010）进内部 Index。

## 双通道共用暂存队列（导入 API 与定时拉取等价）

两通道产出的都是「导入事件」（新文档 / 变更 / 删除），共用同一张暂存表 `import_staged_documents` 与同一个消费 Worker（`ImportWorker`，抄 ADR 0010 Worker 模式：启动即扫 + 2s 轮询 + 乐观抢单 + 指数退避 + 5 次上限），**区别只在入口**：

- **推送通道**（`POST /api/imports/documents`，`@Public` + `ImportAuthGuard`）：外部项目用 `x-api-key`（`IMPORT_API_KEY`）直推；内部调试页用 Bearer JWT（哨兵用户 `IMPORT_SYSTEM_SUB` role='internal'）。校验后经 `withInternalTx` 落暂存（陷阱②：`@Public` 无请求事务，RLS fail closed，必须内部上下文事务）。
- **拉取通道**（`ImportFetchWorker` 定时器 + `POST /api/imports/fetch/run` 手动触发）：`HttpImportSourceAdapter`（`ImportSourcePort` 实现）拉取外部清单 → 逐条 `decideStage` 入队 → **删除派生**（kb 现有 `fetch:*` 文档不在本次清单 → 自动派生 delete 行）。

**键空间隔离**：`externalKey = ${channel}:${sourceKey}`（api/fetch 前缀）——同 sourceKey 双通道推送 = 两个独立文档，互不串扰。暂存行幂等键 `unique(source, sourceKey, action)`（重复推送不重复入队）。

## 指纹去重（幂等推送）

`decideStage` 纯函数（单测矩阵覆盖）：`fingerprint = sha256(内容)`（markdown 对正文、file 对 base64 解码字节）。
- 无既有行 → **insert**（pending 待消费）
- 有行且**指纹相同 + kb 文档仍存在** → **duplicate**（不入队，`duplicateCount+1` 留痕——定时重复拉取的可见记录）
- 否则 → **reset**（同幂等键行重置为 pending 重新入队，`duplicateCount` 清零）
- 删除后同内容重推：kb 文档已硬删 → reset 而非 duplicate（「删后回炉」正确重建，e2e 验收⑦）

## 落库语义：先落草稿，永不自动发布（AC4 前提）

`applyUpsert`（消费时，`withInternalTx` 内）：
- 无文档 → 新建 `source='online_help'` **draft**；
- draft → 更新文档头 + 草稿版本；
- **published/archived → 不碰文档头**，创建/覆盖草稿版本（已发布内容不受导入变更影响，人工重新发布才切换线上内容）。

**人工发布是 RAG 同步的唯一触发点**（复用 kb publish → ADR 0010 管线）——导入内容永远先经内部用户审阅。

## 删除语义 = 硬删除（带 RAG 清理）

`applyDelete` 按 externalKey 反查文档：draft → 直删（无 RAG）；published → 先 `enqueueInTx({action:'delete', versionNumber:最后发布版本})`（RAG 下架）再删行 + Storage 清理；不存在 → no-op 幂等。删除派生行不填 documentId（apply 时反查，删除后文档已不存在，行内引用无意义）。

## 只读约束（AC3）

kb `updateDocument` 对 `source='online_help'` 直接 400（`外部导入文档只读，不可在线编辑`）。发布/归档/恢复**保留**——人工发布是 AC4 前提，归档/恢复语义与内部文档一致。web：列表/详情徽章「外部 · 只读」（`KB_SOURCE_LABELS`），编辑按钮按 source 隐藏。

## 审计时序约束（陷阱①）

所有审计（`import.push` / `import.apply` / `import.delete` / `import.fetch`）**必须在 `withInternalTx` 提交后记录**——内部事务把 ALS 设为 `userId:'system'`（非 uuid），事务内写审计会破坏 `audit_logs.actor_user_id` uuid 列。apply 用 callback-return 模式把审计数据带出事务闭包。

## 外部清单格式 v1（拉取通道契约）

`GET {IMPORT_FETCH_URL}` → JSON 数组（`ImportSourceItem`）：`sourceKey`（通道内稳定唯一键）+ `title` + `category` + `format`（markdown/html → docType='markdown'；pdf/word → docType='file' + `contentUrl` 二次拉取转 base64）+ 可选 `updatedAt`（原样进 metadata，去重以内容指纹为准）。超限丢弃（正文 ≤200KB、文件 ≤6MB 与全仓上传链路一致）。认证：`IMPORT_FETCH_API_KEY` → `Authorization: Bearer`。适配层单测覆盖（未配置 URL→[]、非法枚举、HTTP 错误、html→markdown、contentUrl 拉取、超限/缺失丢弃）。

## 已知取舍

- **先落草稿待人工发布**：外部内容不自动进 RAG（人工把关）；代价是外部项目改文档后需内部人工重新发布才生效（调试页「立即拉取」+ staged 面板可见增量/去重/失败，评估后发布）。
- 暂存行保留全部历史（含已处理行），调试页可见 fingerprint/duplicateCount/attempt/lastError；无清理策略（量级小，后续可加保留窗口）。
- `import_staged_documents` 无 RLS（系统内部表，端点全量 `assertImportActor` 内部角色校验）；`runFetch` 手动触发经 controller 断言、定时器路径内部系统动作不拦。
- 文件类导入落 Storage 后进 kb 版本表（与内部文件上传同链路）；RAG 侧文件文档仍只索引元信息（ADR 0010 口径延续）。
- web 无自动化 e2e（无 Playwright 基建）：/import 调试页验收 = 实现 + `pnpm build` + 后端 e2e 全绿（同 #15–#24 惯例）；e2e 用内存 fake 清单服务器验证双通道、去重、变更/删除派生、删后回炉。
