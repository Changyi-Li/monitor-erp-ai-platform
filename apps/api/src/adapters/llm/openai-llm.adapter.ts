import type { LLMClient, LlmChatInput, LlmChatResult, LlmChatMessage } from './llm-client.port';

export interface OpenaiLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** OpenAI chat/completions 请求消息（多模态 parts 原生透传，text/image_url 可混合） */
type OpenAiMessageContent =
  | string
  | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];

interface OpenAiChatResponse {
  choices?: { message?: { content?: string | { type: string; text?: string }[] | null } | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

/**
 * OpenAI 兼容驱动（issue #24）：原生 fetch 调 {baseURL}/chat/completions，
 * 零 SDK 依赖——DashScope（Qwen-VL 视觉模型）/DeepSeek/GLM 均兼容该协议。
 * 多模态：content parts 透传为 OpenAI image_url 形状；usage 取响应真实 token
 * （prompt_tokens/completion_tokens），model 取响应字段回退配置模型。
 * 构造 = 纯配置校验（零连接）；运行时失败抛错明确（场景隔离语义，不重试）。
 */
export class OpenaiLlmAdapter implements LLMClient {
  private readonly baseUrl: string;

  constructor(private readonly config: OpenaiLlmConfig) {
    if (!config.baseUrl || !config.apiKey || !config.model) {
      throw new Error('LLM openai 驱动配置不完整：baseUrl/apiKey/model 均必填');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
  }

  async chat(input: LlmChatInput): Promise<LlmChatResult> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: input.messages.map(toOpenAiMessage),
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`LLM openai 调用失败 HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
    }

    const data = (await res.json()) as OpenAiChatResponse;
    const raw = data.choices?.[0]?.message?.content;
    const content = Array.isArray(raw)
      ? raw.map((p) => p.text ?? '').join('')
      : (raw ?? '');

    return {
      content,
      usage: {
        model: data.model ?? this.config.model,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}

/** string → 原样；parts → OpenAI 协议 content 数组（text / image_url 双形态） */
function toOpenAiMessage(m: LlmChatMessage): { role: string; content: OpenAiMessageContent } {
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: m.content.map((part) =>
      part.type === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'image_url', image_url: { url: part.imageUrl } },
    ),
  };
}
