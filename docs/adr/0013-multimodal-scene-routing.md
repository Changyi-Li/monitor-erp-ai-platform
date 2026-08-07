# 0013: 多模态与场景化多模型（LLM 场景路由 + 图片解析）

Status: accepted

## 背景

#24 交付 spec §「多模态与场景化多模型」（#80–#82）：**场景（客服问答 / 文档解析 / 操作手册生成 / Embedding 等）→ 配置化的 provider + model 映射**，换模型只改配置不改业务代码；**多模态输入支持**（图片解析：draw.io 蓝图图、文档截图、附件图片，如 Qwen-VL）；场景间隔离（一个场景模型故障不影响其他场景）。

## 场景路由与隔离（wrapper 嵌套）

```
LLM token = UsageRecording( SceneRouting( drivers: Record<LlmScene, LLMClient> ) )
```

- **嵌套顺序**：UsageRecording（#23 计量，最外层）→ SceneRouting（按 scene 分发）→ 各场景独立 driver 实例。路由后 `ai_usage.model` 记录**实际生效模型**（切换场景模型后统计/页面可观测差异）；内层 driver 抛错 → 外层不落库（计量语义不变）。
- **配置兜底链**：`LLM_DRIVER_<SCENE>`（场景专属）→ `LLM_DRIVER`（全局）→ 内置 memory。纯函数 `resolveSceneConfigs(env)` 解析并标注来源（scene/global/default——web 配置页展示）。
- **启动期全量构造 + 配置错误全局 fail-fast**：openai 驱动构造 = 纯配置校验（零连接零网络）；未知驱动名 / openai 缺 `LLM_OPENAI_API_KEY` → 启动即抛（含场景名），env.schema superRefine 同校验双保险。默认配置（全 memory）永不炸，开发体验不变。
- **运行时隔离（AC3）**：每场景独立 driver 实例，场景 X 的 chat() 网络/API 错误只冒泡给 X 的调用方。**不做「失败降级 memory」**——降级掩盖故障（真实驱动挂时应告警而非假装成功），且 memory fake 与真实生成不等价；报错明确（HTTP 状态 + 驱动错误摘要）。

## 场景与模型清单（配置文档化，AC4）

| 场景 | 默认驱动 | 默认模型 | 说明 |
|---|---|---|---|
| agent（客服问答） | memory | memory | 本期唯一生产调用点（agent.graph generate 节点）；性价比模型（Qwen-Plus 等）候选 |
| document_parsing（文档解析） | memory | memory | 图片解析端点（`POST /api/ai/image-parsing`）；视觉模型 Qwen-VL 候选 |
| manual_generation（手册生成） | memory | memory | #26 接入后填充；质量优先（Qwen-Max）候选 |
| embedding（向量化） | memory | memory | 本期无调用方（RAG 走独立 INDEX_DRIVER），仅映射完整性 |

openai-compatible 驱动（`LLM_DRIVER_*=openai`）经原生 fetch 调 `{LLM_OPENAI_BASE_URL}/chat/completions`，零 SDK 依赖——DashScope（`https://dashscope.aliyuncs.com/compatible-mode/v1`，模型如 `qwen-vl-max`）/DeepSeek/GLM 均兼容 OpenAI 协议。`LLM_OPENAI_BASE_URL`/`LLM_OPENAI_MODEL` 缺省值：`https://api.openai.com/v1` / `qwen-vl-max`（显式配置优先）。

## 多模态契约

- `LlmChatMessage.content` 扩为 `string | LlmMessageContentPart[]`（OpenAI 协议形状：`{type:'text',text}` / `{type:'image_url',imageUrl}`；imageUrl 支持 data URL 或 https URL）。string 保持向后兼容——现有调用点（agent.graph）零改动。
- 上传通道复用全仓 JSON+base64 链路（zod ≤8M 字符 → 实测 ≤6MB，`^image/` contentType 校验）——不引入 multipart。
- openai 驱动透传为 OpenAI `image_url: {url}` 标准写法；`usage.prompt_tokens/completion_tokens` → LlmChatUsage（model 取响应字段回退配置模型）；60s 超时，非 2xx 抛错带 status + body 摘要。

## memory fake 的多模态规则（确定性，e2e 可断言）

- system 含 `[图片解析]` 区块标记 + user 消息含 image part → 返回**确定性结构化流程模板**（流程步骤/模块依赖/数据流向 + 「配置 openai 后由真实视觉模型解析」说明）——fake 演示的是整条链路（上传 → 计量 → 审计 → 统计），真实图片理解需配 Qwen-VL。
- token 估算单一规则不变：`inputTokens = ceil(全部消息 messageText 字符和 / 4)`（图片按 data URL 全串字符计入），`model='memory'`。

## API 与前端

- `POST /api/ai/image-parsing`（内部专属，scene='document_parsing'）→ `{content, usage}`；`GET /api/ai/config` → 场景映射表（`LLM_RUNTIME_CONFIG` token 注入，与 LLM 工厂同一次解析——单一事实来源）。权限复用 `agent:use`（不新增权限点，同 ADR 0012 决策）；审计 `ai.image_parse` / `ai.config_view`。
- web `/ai` 页（'use client' + inline styles，isPlatformRole 守卫）：场景→模型映射表（来源/状态可见）+ 图片解析演示（上传 → 结构化结果 + 用量行）。导航入口：topbar + 首页（isPlatformRole 分支）。

## 已知取舍

- **切换模型需重启服务**（env 静态配置，无热更新/配置中心）——与 AC1「不改业务代码」不冲突，web 页明示「改 .env 后重启」。
- memory fake 图片 token 为字符估算（真实视觉定价未模拟），接缝不变——配 openai 后自动准确（ADR 0012 口径延续）。
- 图片 JSON+base64 ≤6MB 上限（与全仓上传链路一致；超大图 400；如需可后续加「先存 Storage 再传 key」通道）。
- embedding 场景无调用方（RAG 独立 INDEX_DRIVER）；openai 驱动本期只实现 `/chat/completions`（无 `/embeddings`），真实向量化留后续切片。
- `content` 双形态仅存在于 LLMClient 内部接缝（不落库、不出 HTTP）。
- openai 驱动无重试/退避（失败明确报错，隔离语义优先；重试可复用 rag 退避模式，后续增强）。
- web 无自动化 e2e（无 Playwright 基建）：/ai 页验收 = 实现 + `pnpm build` + 后端 e2e 全绿（同 #15–#23 惯例）。
