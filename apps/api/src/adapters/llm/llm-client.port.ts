/**
 * 平台侧 LLM 门面（spec §8.5：平台自研 LLMClient 抽象，避免框架绑定；
 * 供 LangGraph 节点 / 操作手册生成等平台自有 AI 功能使用）。
 * 本期仅 memory fake（LLM_DRIVER=memory，确定性输出供 e2e/CI）；
 * 真实 OpenAI 兼容驱动（Qwen/DeepSeek/GLM）连同计量在切片 13/14 接入——
 * 切换实现 = 改 LLM_DRIVER 配置，业务代码零改动（同 IDX/STORAGE/MQ 模式）。
 */
export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmChatInput {
  messages: LlmChatMessage[];
}

export interface LlmChatResult {
  content: string;
}

export interface LLMClient {
  /** 非流式对话（切片 13/14 加流式通道，接缝本接口不变） */
  chat(input: LlmChatInput): Promise<LlmChatResult>;
}
