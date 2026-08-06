import type { AgentCitation, AgentMessage } from '@monitor/contracts';
import { ApiError, tryRefresh } from './api';
import { clearTokens, getAccessToken } from './token-store';

/**
 * 内部客服 AI Agent 流式请求（issue #22）：POST messages → SSE 流。
 * apiFetch 是 res.text() 无法流式，这里用原生 fetch + getReader 逐帧解析
 * （Next 16.3 streaming.md 官方模式；Accept-Encoding: identity 防压缩分块缓冲）。
 * 事件线协议（见 contracts agent schemas 注释）：citations → token* → done。
 */

export interface StreamChatHandlers {
  onCitations?: (citations: AgentCitation[]) => void;
  onDelta?: (delta: string) => void;
  onDone?: (message: AgentMessage) => void;
}

export async function streamChat(
  conversationId: string,
  content: string,
  handlers: StreamChatHandlers,
  signal?: AbortSignal,
  _retried = false,
): Promise<void> {
  const token = getAccessToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept-Encoding': 'identity',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`/api/agent/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content }),
    signal,
  });

  // access token 过期 → refresh 一次重试（同 apiFetch 逻辑）
  if (res.status === 401 && token && !_retried) {
    if (await tryRefresh()) {
      return streamChat(conversationId, content, handlers, signal, true);
    }
    clearTokens();
    window.location.href = '/login';
    throw new ApiError(401, '登录已过期');
  }

  if (!res.ok) {
    let message = '请求失败';
    try {
      const data = (await res.json()) as { message?: string | string[] };
      message = Array.isArray(data.message) ? data.message.join('；') : (data.message ?? message);
    } catch {
      // 非 JSON 错误体
    }
    throw new ApiError(res.status, message);
  }
  if (!res.body) {
    throw new ApiError(500, '流式响应不可用');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 帧以空行分隔；可能跨 chunk，用缓冲累积切帧
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      handleFrame(frame, handlers);
    }
  }
}

function handleFrame(frame: string, handlers: StreamChatHandlers): void {
  let event = '';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7);
    if (line.startsWith('data: ')) data = line.slice(6);
  }
  if (!data) return;
  if (event === 'citations') {
    handlers.onCitations?.((JSON.parse(data) as { citations: AgentCitation[] }).citations);
  } else if (event === 'token') {
    handlers.onDelta?.((JSON.parse(data) as { delta: string }).delta);
  } else if (event === 'done') {
    handlers.onDone?.((JSON.parse(data) as { message: AgentMessage }).message);
  }
}
