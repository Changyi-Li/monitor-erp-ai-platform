/**
 * 平台侧 LLM 门面（spec §8.5：平台自研 LLMClient 抽象，避免框架绑定；
 * 供 LangGraph 节点 / 操作手册生成等平台自有 AI 功能使用）。
 * 本期仅 memory fake（LLM_DRIVER=memory，确定性输出供 e2e/CI）；
 * 真实 OpenAI 兼容驱动（Qwen/DeepSeek/GLM）连同计量在切片 13/14 接入——
 * 切换实现 = 改 LLM_DRIVER 配置，业务代码零改动（同 IDX/STORAGE/MQ 模式）。
 *
 * 用量计量（issue #23，spec #77）：LLMClient 统一记录——chat() 必返 usage
 * （memory fake 为字符数确定性估算，真实驱动填真实 token），调用方经
 * context.scene 标注场景；UsageRecordingLlmClient wrapper 统一落 ai_usage。
 */
export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 用量归属与场景标注（spec 定稿 4 场景；agent 客服无客户/项目绑定 → 归属可空） */
export interface LlmUsageContext {
  scene: 'agent' | 'document_parsing' | 'manual_generation' | 'embedding';
  customerId?: string;
  projectId?: string;
  conversationId?: string;
}

export interface LlmChatInput {
  messages: LlmChatMessage[];
  /** 场景/归属标注——缺省则 UsageRecording wrapper 抛错（防漏标导致无法计量） */
  context?: LlmUsageContext;
}

export interface LlmChatUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmChatResult {
  content: string;
  /** 必填：计量接缝（fake 估算 / 真实驱动真实值，表结构不变） */
  usage: LlmChatUsage;
}

export interface LLMClient {
  /** 非流式对话（切片 13/14 加流式通道，接缝本接口不变） */
  chat(input: LlmChatInput): Promise<LlmChatResult>;
}
