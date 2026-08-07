import type { LLMClient, LlmChatInput, LlmChatResult, LlmChatMessage } from './llm-client.port';
import { messageText } from './llm-client.port';

/**
 * memory fake 驱动：确定性规则回答（无网络/随机/时间依赖，e2e 可断言）。
 *
 * 图 prompt 约定两个区块（agent.graph.ts 组装）：
 *   [检索文档]
 *   [1] 标题：…（摘要：…）
 *   [历史对话]
 *   用户：… / 助手：…
 *
 * 回答规则：
 * - 含检索文档 → 「根据知识库「{top.title}」：{top.content 前 80 字}。更多详情见来源 [1]。」
 * - 用户问题含「刚才/上一问/引用/来源」（追问）→ 复述上一轮用户问题 + 其引用（证明多轮记忆，
 *   记忆来自 prompt 注入的 history——真实 LLM 同机制）
 * - 无检索结果 → 「抱歉，知识库中未找到相关信息。」（不带角标）
 * - 多模态（issue #24）：user 消息含 image part 且 system 含「[图片解析]」区块标记 →
 *   返回确定性结构化流程模板（真实图片理解需配 Qwen-VL 等视觉模型，fake 仅演示链路）
 *
 * 用量（issue #23）：确定性估算——inputTokens = ceil(全部消息字符和 / 4)（多模态
 * 经 messageText 归一化，图片按 data URL 全串字符计入），outputTokens = ceil(回答字符 / 4)，
 * model='memory'（真实驱动填真实值，接缝不变）。
 */
export class MemoryLlmAdapter implements LLMClient {
  async chat(input: LlmChatInput): Promise<LlmChatResult> {
    const userMessage = [...input.messages].reverse().find((m) => m.role === 'user');
    const userText = userMessage ? messageText(userMessage) : '';
    const systemText = typeof input.messages[0]?.content === 'string' ? input.messages[0].content : '';

    const usage = this.estimateUsage(input);

    // 多模态规则：user 消息含图片 + system 约定 [图片解析] 区块（ai.service 组装）→ 流程模板
    if (systemText.includes('[图片解析]') && userMessage && hasImagePart(userMessage)) {
      const content =
        '流程解析（memory 驱动模拟）：1. 上传文件识别 2. 图片解析（当前为确定性模拟）' +
        '3. 结构化输出——流程步骤 / 模块依赖 / 数据流向。' +
        '配置 LLM_DRIVER_DOCUMENT_PARSING=openai 后由真实视觉模型（如 Qwen-VL）解析。';
      return { content, usage: { ...usage, outputTokens: this.estimateTokens(content) } };
    }

    const retrieved = this.parseRetrieved(systemText);
    if (retrieved.length === 0) {
      return { content: '抱歉，知识库中未找到相关信息。', usage };
    }
    const top = retrieved[0]!;

    // 追问 → 复述上一轮用户问题 + 其引用（多轮记忆演示）
    if (/刚才|上一问|引用|来源/.test(userText)) {
      const history = this.parseHistory(systemText);
      const lastUser = history.filter((m) => m.role === 'user').at(-1);
      if (lastUser) {
        const content = `上一轮您问的是「${lastUser.content}」，我依据的来源是「${top.title}」[1]。`;
        return { content, usage: { ...usage, outputTokens: this.estimateTokens(content) } };
      }
    }
    const snippet = top.content.slice(0, 80);
    const content = `根据知识库「${top.title}」：${snippet}。更多详情见来源 [1]。`;
    return { content, usage: { ...usage, outputTokens: this.estimateTokens(content) } };
  }

  /** 输入 token 估算 = ceil(全部消息 messageText 字符和 / 4)；输出按回答内容另算 */
  private estimateUsage(input: LlmChatInput): { model: string; inputTokens: number; outputTokens: number } {
    const chars = input.messages.reduce((sum, m) => sum + messageText(m).length, 0);
    return { model: 'memory', inputTokens: Math.ceil(chars / 4), outputTokens: 0 };
  }

  private estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  }

  /** 解析 system prompt 的 [检索文档] 区块：{title, content} 列表（[n] 编号按数组序） */
  private parseRetrieved(systemText: string): { title: string; content: string }[] {
    // 前瞻必须排除文档自身的 [n] 编号行（用固定区块标记 [历史对话] 收尾）
    const block = systemText.match(/\[检索文档\]([\s\S]*?)\n\[历史对话\]/);
    if (!block) return [];
    const docs: { title: string; content: string }[] = [];
    for (const m of block[1]!.matchAll(/\[(\d+)\]\s*标题：([^\n]+)（摘要：([\s\S]*?)）\n?/g)) {
      docs.push({ title: m[2]!.trim(), content: m[3]!.trim() });
    }
    return docs;
  }

  /** 解析 [历史对话] 区块：{role, content} 列表 */
  private parseHistory(systemText: string): { role: 'user' | 'assistant'; content: string }[] {
    const block = systemText.match(/\[历史对话\]([\s\S]*)$/);
    if (!block) return [];
    const history: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of block[1]!.matchAll(/(用户|助手)：([^\n]+)\n?/g)) {
      history.push({ role: m[1] === '用户' ? 'user' : 'assistant', content: m[2]!.trim() });
    }
    return history;
  }
}

/** 消息是否含图片段（多模态规则触发条件；imageUrl 支持 data URL / https） */
function hasImagePart(m: LlmChatMessage): boolean {
  return Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url');
}
