# RAG 平台选型：RagFlow vs Dify vs 阿里云百炼

> 交付物：wayfinder ticket #3（map issue #1 子项）
> 场景：**Monitor ERP 项目实施管理平台** —— SaaS，数千+客户多租户，中国云部署，**不自己搭建 RAG 基础设施**。
> 最高优先级约束：**客户数据隔离**（客户 A 的知识库/检索结果不得被客户 B 触达）。
> 结论先行：**首选阿里云成立**，具体落点是 **阿里云百炼（Model Studio）知识库 + 智能体应用**，以「每客户一个知识库 + 请求级知识库范围控制 + 应用层租户映射」作为隔离模型。Dify 因许可证限制基本出局；RagFlow 是可自托管的备选方案（许可证友好、深度文档解析强），但需自建运维、多租户仍有边界。

---

## 一、结论摘要（TL;DR）

| 维度 | 阿里云百炼 | RagFlow（自托管） | Dify（社区/企业版） |
|---|---|---|---|
| 多租户/数据隔离 | **每客户独立知识库（Index）**；请求级限定检索范围；⚠️ 业务空间内无按用户/按知识库的细粒度 RBAC，隔离靠应用层实现 | 租户级（tenant_id）DB 层隔离，可一租户一客户；⚠️ 无按知识库 ACL、`kb_ids` 注入风险（open issue #9099） | 社区版许可证禁止多租户 SaaS；企业版（$150k/年）多工作区=一客户一工作区，隔离最强 |
| 文档导入/更新 API | 齐全：AddFile / SubmitIndexAddDocumentsJob（增量）/ UpdateChunk / DeleteIndexDocument / GetIndexJobStatus（异步） | 齐全：上传→async_parse→轮询进度；删/改/批量元数据；支持取消解析 | 齐全：create_by_file/text，batch 轮询索引状态；禁用/归档/删除；chunk 级 CRUD |
| Agent/客服应用 | 智能体应用 + 引用溯源（`DocReferences` / indexed 角标）+ 流式 + 知识检索服务 | 聊天助手/Agent Flow + 引用；能力较弱、生态较新 | **最强**：Chatflow/Agent 编排、插件、引用、webapp 权限 |
| 中国云部署 | 阿里云原生托管 SaaS，无需运维 | 阿里云计算巢一键部署，但**需自运维**（ES/MySQL/MinIO 等 6 件套） | 社区/企业版可部署于阿里云 ECS/K8s，但**需自运维** |
| 成本模型 | 按知识库计费（0.03元/标准版·小时）+ 模型 Token；随客户数线性增长 | 无软件许可费；基础设施 + 运维人力 | 社区版免费但不可商用多租户；企业版约 **$150,000/年** 许可 |

**推荐**：阿里云百炼的「**知识库（Knowledge Studio/Index）+ 智能体应用 + 每客户一 Index + 请求级检索范围控制**」组合，作为 RAG 底座；客服 Agent 的对话层放在自有平台（或百炼智能体应用）之上，租户→知识库映射与访问控制由自有后端强制。

---

## 二、逐维度评估

### ① 多租户 / 租户隔离（最高优先级）

**阿里云百炼**
- 隔离单元分两级：**业务空间（Workspace）** 和 **知识库（Index/Library）**。文档库官方定义为「隔离文档信息、索引信息」；检索请求以 `IndexId`（知识库 ID）+ `WorkspaceId` 必填，天然按库隔离。
- 可行的 SaaS 隔离模型：**每客户一个知识库（Index）**，请求时指定该客户的知识库 ID。支持通过「应用集成操作」的**知识库 ID 列表参数**在运行时限定检索范围（官方文档给出 权限组→知识库映射 的参考实现：`group_index_mapping` 存 group_id→index_id，运行时把当前用户的可见 Index 列表传给应用集成操作）。也可用 `rag_options.IndexID` 为应用补充/限定私有知识。
- ⚠️ **已知边界（必须如实评估）**：
  1. **同一业务空间内不支持按用户隔离**「数据管理/知识索引/我的应用」等模块资源（阿里云官方答疑明确「这几个不可以的」）。即：平台**没有**按知识库/按用户的细粒度 RBAC 界面与 API。
  2. RAM 数据类策略（`AliyunBailianDataFullAccess` / `sfm:Retrieve` 等）作用于**业务空间下全部知识库**，不能按具体 Index 授权。
  3. 因此百炼的隔离是「**数据层按库隔离 + 应用层强制范围**」：平台保证「一次检索只打一个/指定几个库」，但「哪个用户能检索哪个库」必须由你的后端把 `认证客户→IndexId` 映射好，且**绝不能把百炼 API Key 暴露给客户**。
  4. 类目（Category）数量有限（官方 API 文档见「每个业务空间最多 500 个」、集成文档见 1000），大规模客户隔离时应「共享类目 + 每客户独立知识库」，而非每客户一类目。
- 若未来出现强合规/审计要求，可退化为**一客户一业务空间**（API Key 与空间绑定、RAM 策略按空间授权），但数千工作区的管理成本高，第一版不建议。

**RagFlow（自托管）**
- 原生多租户：注册即建 User+Tenant，知识库/文件/聊天助手均以 `tenant_id` 隔离（DB/服务层过滤）。
- 数据层隔离强度不错：索引按 `ragflow_{tenant_id}` 分区；检索用当前租户 Token + `dataset_ids`，跨租户库不可达。
- ⚠️ **已知边界**：
  1. 数据集 `permission` 仅 `me`/`team`，是**租户内**的分享权限，不是跨租户 ACL；**没有按知识库的 ACL/授权 API**。
  2. 聊天接口存在 `kb_ids` 注入风险：用户可传 `kb_ids` 追加到会话可检索库列表（`dia.kb_ids = set(dia.kb_ids + kb_ids)`），理论上可检索助手配置外的库（issue #9099，尚无维护者回复）。
  3. 全局两级权限体系（admin/user，read-only 账号）尚在演进（社区 PR #15164）。
- SaaS 落地建议：**一客户 = 一个 RagFlow 租户账号**（数据层强隔离），但这意味着要管理数千账号/Token、并在自有系统映射客户→租户；隔离强度取决于你对 RagFlow 版本缺陷的补丁/规避。

**Dify**
- 社区版（"modified Apache 2.0"）许可证明文：**「未经 Dify 书面授权，不得使用 Dify 源码运营多租户环境」**，一个 tenant = 一个 workspace。也就是说，用 Dify 社区版做「数千客户共享一套实例的 SaaS」**不合法**；需购买企业商业许可。
- 企业版（约 **$150,000/年** 许可）解锁多工作区管理、SSO、RBAC、审计，可做「**一客户一工作区**」的强隔离。
- 隔离强度一旦用企业版做一客户一工作区，是全平台最强的；但许可+自运维成本高，且管理数千工作区有治理负担。

### ② 文档导入 / 更新 API

| 能力 | 阿里云百炼 | RagFlow | Dify |
|---|---|---|---|
| 上传 | `ApplyFileUploadLease`→`AddFile`；`AddFilesFromAuthorizedOss`（从 OSS 导入） | `POST /api/v1/datasets/{id}/documents`（multipart） | `create_by_file` / `create_by_text` |
| 增量追加 | `SubmitIndexAddDocumentsJob` 追加已解析文件 | `async_parse_documents` 增量解析，可取消 | 文档级替换/文本更新，重触发索引 |
| 删除 | `DeleteIndexDocument`（非结构化库）；`DeleteFile(s)` | `DELETE .../documents`（按 ids） | `DELETE .../documents/{id}`（连带切片/向量） |
| 异步/失败处理 | `GetIndexJobStatus` 轮询；`UpdateIndex` 幂等 | `Document.join()` 轮询进度 `(progress,msg)`，支持取消 | 返回 `batch` ID，`indexing-status` 轮询（waiting→parsing→cleaning→splitting→indexing→completed/error） |
| 切片级 | `UpdateChunk` / `DeleteChunk` | chunk CRUD + 批量可用性 | segment CRUD + 父-子分块 |
| 元数据/标签 | `UpdateFileTag`、`SearchFilters`（检索时标签过滤） | `meta_fields` + `metadata_condition`（检索条件过滤） | 批量 metadata、按外部系统 ID 做增量同步（官方推荐「metadata 存外部主键」模式） |
| 备注 | 文件上传限：单文件<100MB、PDF<100页；解析方式可配 `ChangeParseSetting`（如 .pdf 用大模型解析、.jpg 用 Qwen-VL） | 深度文档解析（DeepDoc）是其强项，适合复杂排版 | 解析规则 automatic/custom；文档更新会全量重建索引 |

三家均能满足「文档增删改后自动同步更新 RAG」；百炼与 Dify 的异步状态机更成熟，RagFlow 对复杂 PDF/版面解析能力最强。

### ③ Agent / 对话应用构建

- **阿里云百炼**：提供**智能体应用**（绑定知识库、Prompt、模型），支持流式输出、多模态引用、多库混合检索与跨库 Rerank。引用溯源规范：请求设 `DocReferenceType=indexed`，回复含 `<ref>[x]</ref>` 角标，响应 `DocReferences[]` 给出 `IndexId/Title/DocId/DocName/DocUrl/Text/页码`，可做「点击引文看原文」。另有**知识检索服务**（发布为 `agent_id`，`/api/v1/indices/knowledge/search`，多库联合检索、策略在服务端配置、返回切片含 `pipeline_id`/`workspace_id`），适合把检索层嵌入自有编排。权限上调用方是「后端 API Key + 业务空间」，细粒度按用户的访问控制在应用层做。
- **RagFlow**：有聊天助手与 Agent（Flow/工作流）能力，支持引用、工具调用，但整体生态与编排能力弱于 Dify/百炼；面向客户客服 Agent 需要较多自建。
- **Dify**：**编排能力最强**（Chatflow、多 Agent、插件、变量、WebApp 分享与成员权限），引用溯源在 WebApp 内可视化呈现。但多租户 SaaS 场景被许可证卡住。

### ④ 中国云部署与托管

- **阿里云百炼**：阿里云原生托管 PaaS，中国区可直接开通；**零运维**，符合「不自己搭建」。控制台/OpenAPI 覆盖知识库、应用、检索全链路。子账号需加入业务空间并配 RAM 数据策略（`AliyunBailianDataFullAccess` 等）方可调 API。
- **RagFlow**：阿里云**计算巢（ComputeNest）提供社区版一键部署**（市场服务，约 20 分钟，按 ECS 规格/盘/带宽计费，支持按量与包年）；但本质是**自托管**——一套 MySQL + Elasticsearch/Infinity + MinIO + Valkey + Nginx + RAGFlow 服务，需自行扩缩容、备份、监控、升级。最低硬件 4C16G/50G SSD，生产建议 8–16C/32G。
- **Dify**：社区版/企业版可部署在阿里云 ECS/K8s（阿里云市场有 Dify Enterprise 与社区版镜像），同样需自运维；官方有 AWS Marketplace $150k/年企业许可条目。

### ⑤ 成本模型

| 平台 | 许可 | 基础设施/规格 | 模型/Token | 备注 |
|---|---|---|---|---|
| 百炼 | 无前置许可 | 知识库规格费：标准版 **0.03 元/库/小时**（1 QPS 固定，≤100GB），旗舰版 **0.2 元/RCU/小时**（1RCU≈50QPS，可 1–200RCU，≤9999GB）；一次性 720h 免费额度（仅标准版） | 向量/排序/问答按 Token：text-embedding-v4、qwen3-rerank ≈0.0005 元/千Token；Qwen 系问答 输入 6–15 元/百万Token、输出 20–40 元/百万Token | **规格费随知识库数量线性增长**：N 个客户×N 个标准版库，每库约 21.6 元/月（0.03×24×30）。例：5000 客户 ≈ 10.8 万元/月 仅规格费 + Token。检索时 Query 向量化与 Rerank 消耗按检索库数量倍数增加 |
| RagFlow | Apache 2.0，免费 | 自购 ECS/存储/带宽；生产建议 8–16C/32G + ES 集群 | 可接 Qwen/DeepSeek 或本地 Ollama/vLLM | 无许可费，但含运维人力；规模上成本低于百炼，代价是自建自维 |
| Dify | 社区版免费但**禁止多租户 SaaS**；企业版 **≈$150,000/年** | 自购 ECS/K8s；或 Dify Cloud 按工作区订阅（Pro $59/月、Team $159/月，均含工作区/席位/额度限制） | 自带模型 Key 另付 | 数千客户若走 Dify Cloud 每客户一工作区，成本不可行；企业版许可费高 |

---

## 三、推荐方案（落到百炼能力组合）

> 验证结论：**「首选阿里云」成立**。理由：原生中国云托管（满足「不自己搭建」）、每客户一知识库可做到数据层按库隔离、文档导入/更新 API 齐全、智能体应用自带引用溯源、成本可预测。**前提是接受「应用层强制隔离」的模型并落实下列红线**。

**落地组合（百炼能力）**：
1. **知识库（Index）**：`CreateIndex` + `SubmitIndexJob` 每客户建一个库（**非结构化知识库**）；标准版起步，高并发/大客户升旗舰版 RCU。
2. **文档生命周期**：`ApplyFileUploadLease`→`AddFile`（或 `AddFilesFromAuthorizedOss`）→`SubmitIndexAddDocumentsJob` 增量追加；`UpdateChunk`/`DeleteIndexDocument`/`DeleteIndex` 维护；`GetIndexJobStatus` 轮询异步状态；`ChangeParseSetting` 配置复杂 PDF/图片解析（大模型解析 / Qwen-VL）。文档编辑后由平台后端触发「更新索引」完成自动同步。
3. **检索与客服 Agent**：客服对话走**智能体应用**（绑定知识库、Prompt、Qwen 模型），请求设 `DocReferenceType=indexed` 拿到 `<ref>[x]</ref>` 角标 + `DocReferences[]` 做引用溯源；流式输出；需要自有编排时用 **知识检索服务**（`agent_id` + `/api/v1/indices/knowledge/search`）只做多库检索，或 `Retrieve`（`IndexId` 必填）单库检索。
4. **隔离红线（必须落实）**：
   - 每客户一个 Index；**客户查询时由后端注入该客户可见的 Index 列表**（运行时知识库 ID 列表参数 / `rag_options.IndexID`），禁止把全部库暴露给请求。
   - 百炼 API Key 只存在**自有后端**，绝不下发客户端；RAM 用自定义策略做最小授权（如 `sfm:Retrieve`、`sfm:ListIndex`），子账号限定必要权限。
   - 明确告知产品：**百炼业务空间内无按用户/按库的细粒度 RBAC**，知识库层隔离由自有后端强制；这是「租户映射在应用层」的标准 SaaS 做法，但不等同于平台级每个客户一套凭证。
   - 文档类目用共享类目，避免触达类目数量上限。
5. **成本治理**：只对活跃客户保留「运行中」知识库，停用/删除休眠客户的库以停掉规格费（删除库是唯一停止规格费的方式）；检索侧调低初步召回 TopK 或按需关闭 Rerank 控制 Token 成本。

**备选路径（不建议首选）**：
- 若预算充足且要「平台级每客户强隔离/审计」：Dify 企业版（≈$150k/年许可 + 自运维）做一客户一工作区；但许可+运维+治理成本高。
- 若百炼的文档解析质量（复杂 ERP 操作手册 PDF）不达标，或每客户规格费在规模上不可接受：自托管 **RagFlow**（Apache 2.0，DeepDoc 解析强，阿里云计算巢一键部署），但需接受自运维与多租户边界（一客户一租户账号、规避 `kb_ids` 注入、无按库 ACL）。

---

## 四、主要风险与待确认项

1. **百炼「业务空间内无细粒度 RBAC」** 是最大边界：隔离正确性完全依赖自有后端映射。上线前应做跨客户检索的渗透测试（A 客户 Token 仅能命中 A 的 Index）。
2. **每客户一知识库的成本线性增长**：数千客户时规格费可观（约 21.6 元/库/月），需与商业模式匹配，并设计休眠/归档策略。知识库创建数量上限未检索到硬性限制，需向阿里云确认。
3. **RagFlow `kb_ids` 注入**（#9099）是自托管路线的已知安全缺口，采用前需验证所用版本并规避。
4. **Dify 许可证**：任何「多租户 SaaS」路径都必须先与 Dify 签署商业许可，否则不合规。
5. 百炼请求级知识库范围控制的参数细节（运行时 ID 列表 / `rag_options` 结构、单请求可指定的库数量上限）应以官方 OpenAPI 文档为准做 PoC 验证。

---

## 五、参考资料（主要一手来源）

- 阿里云百炼 RAM 权限：https://help.aliyun.com/zh/model-studio/bailian-ram-permission
- 百炼知识库计费说明：https://help.aliyun.com/zh/model-studio/billing-for-knowledge-base
- 百炼 CreateLibrary：https://help.aliyun.com/zh/model-studio/api-dianjin-2024-06-28-createlibrary
- 百炼知识库（索引）API（CreateIndex / SubmitIndexAddDocumentsJob / DeleteIndexDocument / UpdateIndex / Retrieve）：https://next.api.aliyun.com/document/bailian/2023-12-29/overview ；Retrieve：https://www.alibabacloud.com/help/zh/model-studio/api-bailian-2023-12-29-retrieve
- 百炼检索增强应用 API（`/v2/app/completions`、`DocReferenceType`、`DocReferences`）：https://help.aliyun.com/zh/model-studio/use-api-to-apply-retrieval-enhancement
- 百炼知识检索服务（agent_id）：https://help.aliyun.com/zh/model-studio/knowledgesearch
- 控制百炼 RAG 应用检索范围（权限组→知识库映射）：https://help.aliyun.com/zh/mobi/control-knowledge-base-retrieval-scope
- 百炼同业务空间内资源隔离答疑（官方群答复「不可以」）：https://developer.aliyun.com/ask/658398
- RagFlow HTTP API（dataset permission、documents、retrieval）：https://ragflow.io/docs/http_api_reference
- RagFlow 部署要求与 Docker 栈：https://ragflow.io/docs/quickstart
- RagFlow 多租户讨论 / kb_ids 注入：https://github.com/orgs/infiniflow/discussions/8114 ；https://github.com/infiniflow/ragflow/issues/9099 ；全局两级权限 PR：https://github.com/infiniflow/ragflow/pull/15164
- RagFlow 许可证（Apache-2.0）：https://github.com/infiniflow/ragflow （LICENSE）；阿里云市场 Ragflow 社区版
- Dify Knowledge API：https://docs.dify.ai/en/api-reference/guides/knowledge
- Dify 许可证（多租户限制）与社区讨论：https://github.com/langgenius/dify/issues/17109 ；https://stackoverflow.com/questions/79828625/dify-open-source-license-compliance-for-customer-bots
- Dify 企业版定价 / AWS Marketplace $150k/年：https://aws.amazon.com/marketplace/pp/prodview-vhluia2quhiuu ；https://dify.ai/zh/pricing/dify-enterprise
- RagFlow 阿里云部署（计算巢）：https://help.aliyun.com/zh/compute-nest/use-cases/ragflow-community-edition-service-instance-deployment-document
- 阿里云百炼同空间无按用户隔离：https://developer.aliyun.com/ask/658398
