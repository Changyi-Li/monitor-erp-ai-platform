import type { LlmScene } from '@monitor/shared';

/**
 * 平台侧 LLM 门面（spec §8.5：平台自研 LLMClient 抽象，避免框架绑定；
 * 供 LangGraph 节点 / 操作手册生成等平台自有 AI 功能使用）。
 * 场景化多模型路由（issue #24，spec #80–#82）：LLM 门面按 context.scene 路由到
 * 各场景配置的驱动（LLM_DRIVER_<SCENE> 回退 LLM_DRIVER，换模型只改配置业务代码零改动）；
 * 多模态输入（text + image_url parts，OpenAI 协议形状，Qwen-VL 等视觉模型兼容）。
 *
 * 用量计量（issue #23，spec #77）：LLMClient 统一记录——chat() 必返 usage
 * （memory fake 为字符数确定性估算，真实驱动填真实 token），调用方经
 * context.scene 标注场景；UsageRecordingLlmClient wrapper 统一落 ai_usage。
 */

/** 文本内容段（OpenAI 协议 content part） */
export interface LlmTextContentPart {
  type: 'text';
  text: string;
}

/** 图片内容段（imageUrl 支持 data URL（data:image/png;base64,...）或 https URL） */
export interface LlmImageContentPart {
  type: 'image_url';
  imageUrl: string;
}

export type LlmMessageContentPart = LlmTextContentPart | LlmImageContentPart;

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  /** string 保持向后兼容（纯文本调用方零改动）；parts 供多模态（图片解析等） */
  content: string | LlmMessageContentPart[];
}

/** 用量归属与场景标注（spec 定稿 4 场景，单一事实来源 shared LLM_SCENES） */
export interface LlmUsageContext {
  scene: LlmScene;
  customerId?: string;
  projectId?: string;
  conversationId?: string;
}

export interface LlmChatInput {
  messages: LlmChatMessage[];
  /** 场景/归属标注——缺省则路由与计量 wrapper 抛错（防漏标导致无法计量） */
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

/**
 * 消息归一化纯函数：content 为 string 原样返回；parts 则 text 段与 imageUrl 全串
 * （含 data:...;base64, 前缀）拼接。memory 估算与 openai 非 parts 分支共用——
 * 图片按 data URL 字符数计入 token 估算（fake 确定性规则，真实驱动填真实值）。
 */
export function messageText(m: LlmChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .map((part) => (part.type === 'text' ? part.text : part.imageUrl))
    .join('');
}
