# 调研：Monitor ERP 项目实施管理平台 — 技术栈推荐

> 方式finder ticket #2（map issue #1 的子问题）。本调研基于官方文档/一手资料 + 工程判断，输出推荐方案、理由与备选。
> 结论不依赖票 #3（RAG 平台选型）的结果：RAG 提供方通过一个 `DocumentIndexPort` 适配层隔离，Dify / RagFlow / 阿里云百炼任一方案均可接入。

---

## 1. TL;DR（推荐方案一览）

| 层 | 推荐（Primary） | 备选 |
|---|---|---|
| 前端 | **Vue 3 + TypeScript + Element Plus + Pinia + Vite** | React 18 + Ant Design Pro + Zustand |
| 后端 | **Java 21 + Spring Boot 3.x** | Go (Gin) / Node.js (NestJS) |
| 关系库 / 多租户 | **阿里云 PolarDB-PG（或 RDS PostgreSQL）+ 共享 Schema + `tenant_id` + PostgreSQL RLS 兜底** | PolarDB-MySQL + MyBatis-Plus 多租户拦截器 |
| 对象存储 | **阿里云 OSS**（STS 临时凭证 + 签名 URL，私有 Bucket） | MinIO（自托管） |
| 消息队列 | **阿里云 RocketMQ**（文档变更 → RAG 同步事件） | MNS / 托管 Kafka |
| 鉴权 / 权限 | **Spring Security + JWT + RBAC（租户域内），自建账号体系** | Sa-Token |
| LLM 抽象 | **Spring AI Alibaba（或自研 OpenAI 兼容 `LLMClient` 接口）**，可配 LiteLLM 网关 | 直连 DashScope/DeepSeek 等供应商 SDK |
| 缓存 | 阿里云 Tair（Redis） | — |
| 搜索（二期可选） | PostgreSQL FTS 起步 → 阿里云 OpenSearch / Elasticsearch | — |

核心决策逻辑：

- **"稳 + 招人易 + 阿里云生态"** → 后端选 Java 生态，前端选中国企业中后台主流。
- **"数千+租户"** → 数据库多租户用**池模型（pool）+ 行级隔离**，不用"每租户一库"，控制运维成本；用 PostgreSQL RLS 做**数据库层强制隔离**（防御纵深，ERP 数据敏感）。
- **"RAG 不自建 + LLM 可切换"** → 把 RAG 提供方与 LLM 供应商都做成抽象接口；RAG 平台（Dify/RagFlow/百炼）均提供异步文档导入 + 检索 HTTP API，可直接对接。
- **"中国云部署"** → 全部组件尽量选阿里云**托管服务**（PolarDB/RDS、OSS、RocketMQ、Tair），减少自运维。

---

## 2. 逐层推荐与理由

### 2.1 前端：Vue 3 + TypeScript + Element Plus + Pinia + Vite

理由：

- 中国企业级中后台（ERP/CRM/项目管理）目前主流是 **Vue 3 + Element Plus**：开发效率高（SFC、Composition API）、中文文档/社区庞大、招聘容易；Vue 2 已于 2024 年停止维护，新项目直接 Vue 3。
- Element Plus 提供 60+ 组件，覆盖强表单驱动的 ERP/项目管理场景（表格、表单、流程、上传）。
- TypeScript 保证大型多租户系统（角色/权限/多组织）的类型安全与可维护性。
- Vite 构建冷启动快；状态管理用 Pinia；路由用 Vue Router。
- 可视化/看板（项目进度、甘特、里程碑）可接入 **ECharts**（Apache）或 **AntV G2**（蚂蚁，与 Element 并存无冲突）。

备选：**React 18 + Ant Design Pro + Zustand**。若团队 React 经验更强、或需要更高动态交互/国际化，Ant Design Pro 是企业级后台完整方案；Ant Design Vue 由社区维护、生态略逊于 React 版。

### 2.2 后端：Java 21 + Spring Boot 3.x

理由：

- 中国企业级 SaaS/ERP 的主流与"最稳妥"选择：生态成熟（Spring Boot 3 + Spring Cloud Alibaba）、稳定性高、**国内开发者基数最大，招聘最容易**。
- 与阿里云生态原生集成：Nacos（注册/配置）、Sentinel（限流熔断）、Seata（分布式事务）等随业务规模按需引入。
- **直接满足"LLM 模型层抽象、可切换"**：`Spring AI Alibaba` 提供 `ChatModel` / `EmbeddingModel` 统一抽象，原生支持通义千问/DashScope，并支持 OpenAI 兼容模式接入 DeepSeek、GLM、豆包等；换模型 = 改配置，不改业务代码（详见 §2.6）。
- 与 Dify / RagFlow / 百炼的集成都是 REST/HTTP API，无语言绑定；Spring 生态有现成的 RestClient/WebClient。
- Java 21 Virtual Threads 解决高并发连接场景，起步阶段单服务（模块化单体）即可支撑数千租户，无需一开始就拆微服务。

备选：

- **Go (Gin)**：并发能力强、单二进制部署轻、云原生友好；但企业级中间件/分布式事务/权限框架成熟度不如 Java，复杂 ERP 业务逻辑下生态偏新。
- **Node.js (NestJS)**：前后端同 TS、迭代快；但强事务/复杂权限/分布式场景的企业级支撑弱于 Spring。

### 2.3 关系数据库与多租户：PolarDB-PG（或 RDS PostgreSQL）+ 池模型 + RLS

**多租户模型选择（针对"数千+租户"）**：

| 模型 | 说明 | 适配性 |
|---|---|---|
| 池模型 Pool | 单个集群/库，所有租户共享，靠 `tenant_id` + 隔离策略隔离 | **推荐**：成本最低、运维最简单、弹性最好，符合数千+租户 |
| 桥接模型 Bridge | 每租户独立 Schema/库，或大租户独享、小租户共享 | 对超大/高合规租户做升级通道 |
| 孤岛模型 Silo | 每租户独立实例 | 成本与运维不可行（数千+租户），不推荐 |

**推荐组合**：

- **数据库**：阿里云 **PolarDB-PG**（云原生、计算存储分离、弹性、支持 RLS）或 **RDS PostgreSQL**（成本更低）。两者均**全托管**、支持 **PostgreSQL 行级安全（RLS）**。
- **隔离机制（双保险）**：
  1. **应用层**：Spring Security 租户上下文（ThreadLocal）→ 所有查询注入 `tenant_id` 条件；配合 ORM 多租户拦截器（MyBatis-Plus 的 `TenantLineInnerInterceptor`）自动拼过滤条件，防漏写。
  2. **数据库层（兜底）**：对每张租户表 `ENABLE ROW LEVEL SECURITY`，策略 `USING (tenant_id = current_setting('app.current_tenant'))`，应用连接在事务开始设置会话变量。即使应用层某处漏了过滤，数据库也拒绝跨租户读写。
- **为什么 PG 而不是 MySQL**：
  - RLS 是 PostgreSQL 原生能力（AWS SaaS Builder Toolkit 对"托管 PG 多租户"的标准推荐），MySQL 无对应能力（只能靠应用层拦截器）。
  - ERP 数据敏感，数据库层强制隔离价值高。
  - **Dify 内部就使用 PostgreSQL**，若票 #3 选 Dify，平台主库与 RAG 元数据库技术栈统一，运维心智一致。
- **备选**：若团队以 MySQL 为主、招聘/存量强偏好 MySQL → **PolarDB-MySQL + MyBatis-Plus `TenantLineInnerInterceptor`**（中国主流做法），隔离完全靠应用层拦截器 + 严格 Code Review；超大规模再考虑 PolarDB-X 分库分表。

### 2.4 文档/对象存储：阿里云 OSS

- 蓝图、会议纪要附件、知识库原始文档统一入 **OSS**（私有 Bucket），按租户目录前缀 `tenant-{id}/...` 组织。
- **安全访问**：通过 **STS 临时凭证（`AssumeRole`）** 或 **签名 URL（presigned URL）** 授权，最小权限、可过期，不暴露长期 AK；有效期 900s–43200s，适合浏览器预览/下载（设置 `Content-Disposition: inline` 直接预览）。
- 阿里云托管、三副本、低成本、可选跨区域复制；配合 CDN 加速大文件分发。
- 文档预览：前端集成预览组件；复杂格式（Office/PDF）可后续接阿里云**智能媒体管理（IMM）** 做转换/预览。
- 注：若自托管 Dify/RagFlow，其自带 MinIO 作为其**内部**文件存储，与平台业务文件（OSS）是两回事，互不冲突；平台文件仍用 OSS。

### 2.5 消息队列：阿里云 RocketMQ（云消息队列 RocketMQ 版）

- 核心事件流：**文档/知识库变更（创建、更新、删除）→ 发布事件 → 消费者调用 RAG 平台异步同步 API**（导入 → 轮询索引状态）。RocketMQ 正好承担这个"事件驱动"底座。
- 选择 RocketMQ 而非 Kafka/MNS 的理由：
  - 阿里云官方对"新建业务消息场景"**首推 RocketMQ**：功能最全（普通/顺序/定时/事务消息），双11 验证的可靠性，毫秒级投递。
  - **事务消息**可解决"业务落库 + 事件发布"的原子性（如：会议纪要已保存，但文档变更事件发失败——用事务消息保证最终一致）。
  - 国内部署即用，无需跨云。
- **备选**：**MNS**（RocketMQ 轻量版，HTTP/REST，开箱即用，适合简单异步通知；如需快速上线可先用 MNS 后迁 RocketMQ）；**托管 Kafka**（面向日志/大数据流，非本场景首选）。
- 进阶：若未来事件路由模式增多（多消费者、过滤、回放），可在 RocketMQ 之上接 **EventBridge**（阿里云事件总线）。

### 2.6 鉴权 / 权限：Spring Security + JWT + RBAC（租户域内）

- **自建账号体系**（要求）：平台自己维护用户表，覆盖两类账号——**内部员工**（跨租户，平台/项目视角）与**外部客户用户**（归属某租户）。
- **模型**：`tenant`（客户组织）、`user`、`role`、`permission`、`user_tenant`（用户-租户映射）。RBAC 权限在**租户域内**判定：登录后解析出 `(tenant_id, roles, permissions)`，写入租户上下文。
- **会话/令牌**：JWT Access Token + Refresh Token（可上 Redis 存会话、支持踢人/下线/同端互斥）。
- **为什么 Spring Security 而非更轻的 Sa-Token**：企业标准、与 Spring 生态无缝、OAuth2/OIDC/SAML 等协议现成（未来若要对接 SSO/企业微信/钉钉登录容易）、大厂验证多。Sa-Token 作为备选（国产轻量、会话管控 API 极简、中文文档好、适合快速迭代）。

### 2.7 LLM 抽象层（主模型 + Embedding 可切换）

**推荐：Spring AI Alibaba 抽象 +（可选）LiteLLM 网关。**

- **方案 A（推荐，Java 侧）**：用 **Spring AI Alibaba** 的 `ChatModel` / `EmbeddingModel` 接口。原生支持通义千问（DashScope），且通过 **OpenAI 兼容模式**（`base-url=https://dashscope.aliyuncs.com/compatible-mode`）或自定义 provider 接入 DeepSeek、GLM、Moonshot、OpenAI 等。**换供应商 = 改配置/换 starter，业务代码不动**。这与约束"LLM 模型层抽象、可切换"完全契合。
- **方案 B（网关，可选）**：部署 **LiteLLM Proxy**（开源，Python），对 100+ 模型商暴露统一 OpenAI 兼容 API，支持路由、故障回退（如 DeepSeek 挂→自动切 Qwen）、限流、成本追踪。适合"多模型 A/B、灰度切换、成本治理"诉求更重的团队。
- **主模型候选**：Qwen-Max / Qwen-Plus（百炼）、DeepSeek-V3/R1、GLM-4、Moonshot 等——全部通过配置切换。
- **Embedding 候选**：DashScope `text-embedding-v3`（中国部署、中文效果好）、OpenAI `text-embedding-3`、Jina，或自托管 BGE/`bge-m3`。
- **注意解耦**：Dify / RagFlow / 百炼**内部各自管理 embedding 与检索模型**（由票 #3 决定），平台侧的 LLM 抽象服务于**平台自有 AI 功能**（智能问答、纪要摘要、文档总结、写作辅助）。两者解耦，互不影响切换。

### 2.8 缓存：阿里云 Tair（Redis）

- 用途：JWT 会话/黑名单、热点数据（租户配置、权限缓存）、分布式锁（Redisson）、限流计数、RAG 同步任务状态缓存。
- Tair 为阿里云托管 Redis 兼容服务；自建 Redis 亦可但运维成本高，不推荐。

### 2.9 搜索（二期/可选）

- 业务元数据全文检索（项目名、蓝图标题、纪要关键词）起步可用 **PostgreSQL 全文检索（FTS）** 或简单 `LIKE`+索引。
- 若检索/向量混合检索需求放大，接 **阿里云 OpenSearch**（全托管，含向量检索版/LLM 智能问答版）或 **Elasticsearch** 托管。注意：**RAG 的向量检索由所选 RAG 平台负责，不在此层重复建设**。

---

## 3. 多租户与 RAG 平台的映射

平台租户（客户组织）与 RAG 平台知识库（dataset）的隔离策略：

- **推荐：一租户一知识库（dataset）**。
  - Dify：每租户创建一个 dataset，用**独立的 Knowledge API Key** 或按 `dataset_id` 控制访问；Dify 开源版以 workspace/tenant_id 做逻辑隔离。
  - RagFlow：每租户一个 dataset，检索 API `POST /api/v1/retrieval` 按 `dataset_ids` 限定范围；对高安全需求租户可部署独立 RagFlow 实例（物理隔离）。
  - 百炼：每租户一个知识库（`CreateIndex`），检索用 Responses API 的 `file_search` + `vector_store_ids` 指定。
- 平台文档同步事件流：平台业务库保存文档 → 发 RocketMQ 事件 → 同步 worker 调用 RAG 适配器（导入 → 轮询状态 → 记录 `external_doc_id` ↔ 平台文档 ID 映射），保证幂等与重试。

---

## 4. 票 #3 输入：RAG 平台集成便利性对比

三者均满足"文档导入 API + 托管检索 + HTTP API Key 认证"，且**均为异步导入、轮询索引状态**的模式，可用同一个适配器封装：

| 维度 | Dify | RagFlow | 阿里云百炼（Model Studio） |
|---|---|---|---|
| 部署 | 自托管（Docker Compose，4C/16G 起）或 Dify Cloud | 自托管（Docker Compose，4C/16G 起，依赖 MySQL+Elasticsearch/Infinity+MinIO+Redis） | **全托管**（SaaS，免运维） |
| 建库 | `POST /datasets` | `POST /api/v1/datasets` | `CreateIndex` OpenAPI + workspace_id |
| 文档导入 | `POST /datasets/{id}/document/create_by_text` / `create-by-file`（multipart），返回 `batch` 轮询 | `POST /api/v1/datasets/{id}/documents`（multipart）→ `POST /api/v1/datasets/{id}/chunks` 解析 → `POST /api/v1/documents/ingest` | OpenAPI 数据导入（OSS 授权 / 上传租约 + 文件导入），支持从 OSS 直接导入 |
| 检索 | `POST /datasets/{id}/retrieve`（keyword/semantic/hybrid + rerank） | `POST /api/v1/retrieval`（hybrid，similarity_threshold / vector_similarity_weight） | Responses API `file_search` 工具 + `vector_store_ids`；或旧版 RAG 应用 `completion` |
| 认证 | `Authorization: Bearer <API_KEY>` | `Authorization: Bearer <API_KEY>` | API Key（阿里云 OpenAPI 凭据） |
| 中国部署 | 需自行部署于阿里云 ECS/ACK（可用镜像仓库 `registry.cn-hangzhou.aliyuncs.com`） | 同左，官方提供阿里云镜像 | 原生在阿里云，无需自管 |
| 与平台耦合 | 低（纯 HTTP API） | 低（纯 HTTP API） | 最低（全托管，但模型/检索能力受平台约束） |

**对架构的影响**：三者都能用统一 `DocumentIndexPort`（createNamespace / upsertDocument / getIndexStatus / retrieve）接入，**票 #3 的选择不改变本推荐的整体技术栈**，只影响"RAG 是自托管（要管 Dify/RagFlow 那套中间件）还是托管（百炼）"的运维复杂度。

---

## 5. 阿里云部署拓扑（起步 → 规模化）

**阶段 1（单租户验证 / 起步）**：ECS（Docker Compose）运行 Spring Boot 单体 + 自托管 RAG（若票 #3 选 Dify/RagFlow）或直连百炼；数据库用 RDS PG；OSS / RocketMQ / Tair 用托管。

**阶段 2（数千租户 / 规模化）**：

```
前端(静态) ── OSS + CDN + ALB/API 网关
   │
   └─> ACK (K8s) ── Spring Boot 服务（模块化单体/按域拆分）
         ├─ PolarDB-PG（共享库 + RLS，多租户）  ── 平台业务数据
         ├─ OSS（蓝图/纪要/知识库原文件，STS 访问）
         ├─ RocketMQ（文档变更事件 → RAG 同步）
         ├─ Tair/Redis（会话/缓存/锁）
         └─ RAG 适配器 ──> Dify / RagFlow（自托管于 ECS/ACK）或 百炼（托管）
```

运维/合规提示：

- 域名需 **ICP 备案**（中国云访问前提）；数据落在国内地域，满足数据驻留要求。
- 可观测：阿里云 ARMS / Prometheus / SLS（日志服务）。
- RLS 性能：合理设置连接池 + `app.current_tenant` 会话变量开销可忽略；对高频表加 `(tenant_id, ...)` 复合索引。

---

## 6. 备选方案汇总

- **备选 A（MySQL 主流派）**：Vue3+Element Plus / **Spring Boot + PolarDB-MySQL** / MyBatis-Plus `TenantLineInnerInterceptor` 多租户 / OSS / RocketMQ / Spring Security。适合 MySQL 存量强、招聘以 MySQL 为主、能严格执行"所有查询带租户条件"代码规范的团队；代价：无数据库层兜底隔离。
- **备选 B（Go 云原生派）**：React+AntD 或 Vue3 / **Go (Gin) + GORM** / RDS PG + RLS / OSS / RocketMQ / Casbin 或自研 RBAC / LiteLLM 网关。适合追求极致性能、单二进制部署、团队 Go 经验强的场景；代价：企业级业务/权限生态需更多自建。

---

## 7. 风险与开放问题

1. **票 #3 结果**：RAG 自托管（Dify/RagFlow）会引入额外的中间件运维（其自带 PG/ES/MinIO/Redis），建议在票 #3 里明确托管 vs 自托管的运维预算。
2. **多租户**：池模型 + RLS 需在项目早期就定下"租户上下文贯穿 + RLS 策略"规范，否则后期补成本高。
3. **LLM 抽象**：即便用 Spring AI Alibaba / LiteLLM，仍建议平台侧定义自己的 `LLMClient`（chat/embed）门面，避免框架绑定。
4. **合规**：ICP 备案、数据驻留、外部客户数据权限审计（RBAC + RLS 可审计）。
5. **权限模型粒度**：ERP 场景往往需要"数据权限"（租户内再按项目/角色细分行级可见性），建议在 RBAC 之上预留数据权限规则引擎（如 MyBatis-Plus 数据权限插件或 RLS 策略扩展）。

---

## 8. 来源（Sources）

**RAG 平台**
- Dify Knowledge API（官方文档）：https://docs.dify.ai/en/api-reference/guides/knowledge
- Dify Create Document by File：https://docs.dify.ai/en/api-reference/documents/create-document-by-file
- Dify Retrieve Chunks / Test Retrieval：https://docs.dify.ai/en/api-reference/knowledge-bases/retrieve-chunks-from-a-knowledge-base-test-retrieval
- RAGFlow HTTP API（官方文档）：https://ragflow.io/docs/http_api_reference
- RAGFlow 配置/部署：https://ragflow.io/docs/configurations ；Docker 部署：https://github.com/infiniflow/ragflow/tree/main/docker
- 阿里云百炼 数据导入：https://www.alibabacloud.com/help/zh/model-studio/data-import-instructions
- 阿里云百炼 知识检索（file_search）：https://www.alibabacloud.com/help/zh/model-studio/file-search
- 阿里云百炼 OpenAPI 概览：https://next.api.aliyun.com/document/bailian/2023-12-29/overview
- 阿里云百炼 OpenAI 文件接口兼容：https://www.alibabacloud.com/help/zh/model-studio/openai-file-interface

**阿里云基础设施**
- PolarDB 产品介绍/特性：https://cn.aliyun.com/product/polardb/features
- RDS 与 PolarDB 数据库选型总览：https://help.aliyun.com/zh/apsaradb/purchase-guide-for-alibaba-cloud-apsaradb
- OSS 授权访问（STS/签名 URL）：https://help.aliyun.com/en/oss/developer-reference/authorized-access-1
- 阿里云消息队列选型（RocketMQ/MNS/Kafka 定位）：https://developer.aliyun.com/article/1090187
- OpenSearch 产品选型：https://www.alibabacloud.com/help/zh/open-search/select-an-opensearch-edition

**多租户 / 数据库隔离**
- AWS SaaS Builder Toolkit — 托管 PostgreSQL 多租户（池模型 + RLS 模式，可迁移到阿里云 RDS/PolarDB PG）：https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/

**LLM 抽象**
- Spring AI Alibaba（官方文档，含 OpenAI 兼容模式）：https://java2ai.com/integration/chatmodels/openai-compatible/
- LiteLLM（统一模型网关，OpenAI 兼容）：https://docs.litellm.ai/

**前端/后端选型（市场与生态判断）**
- Vue3 + Element Plus 企业级后台实践（社区/多源综述）：https://blog.gitcode.com/ebf82faf2b29aee07ece5af594a46e0f.html
- Element Plus 与 Ant Design 对比：https://juejin.cn/post/7470331424588841011
- 中国后端语言选型（Java/Go/Node 综述）：https://blog.csdn.net/chenchuang0128/article/details/153618278
- Spring Security / Shiro / Sa-Token 对比：https://cloud.tencent.cn/developer/article/2610853

> 注：前端/后端"生态主流"类论断来自多来源综述（上述社区/博客），其余组件能力论断均尽量锚定官方文档一手来源。
