'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  AgentConversationSchema,
  AgentConversationsResponseSchema,
  AgentMessagesResponseSchema,
  type AgentCitation,
  type AgentConversation,
  type AgentMessage,
} from '@monitor/contracts';
import { apiFetch, errorMessage } from '../../lib/api';
import { streamChat } from '../../lib/agent';
import { citationUrl, splitAnswerWithCitations } from '../../lib/agent-labels';

/**
 * 内部客服 AI 客服页（issue #22 验收④ demo path）：
 * 提问 → 流式回答 + 引用角标 → 点击角标跳转知识库原文 →
 * 多轮追问（checkpoint 记住上下文）→ 会话历史回看/继续。
 * 内部专属（agent:use）；客户用户访问后端 403 兜底。
 */

export default function AgentPage() {
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingAnswer, setStreamingAnswer] = useState('');
  const [streamingCitations, setStreamingCitations] = useState<AgentCitation[]>([]);
  const [error, setError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  async function loadConversations() {
    try {
      const res = await apiFetch('/api/agent/conversations', {
        schema: AgentConversationsResponseSchema,
      });
      setConversations(res.conversations);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function openConversation(id: string) {
    setActiveId(id);
    setStreamingAnswer('');
    setStreamingCitations([]);
    try {
      const res = await apiFetch(`/api/agent/conversations/${id}/messages`, {
        schema: AgentMessagesResponseSchema,
      });
      setMessages(res.messages);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleNew() {
    try {
      const res = await apiFetch('/api/agent/conversations', {
        method: 'POST',
        schema: AgentConversationSchema,
      });
      await loadConversations();
      await openConversation(res.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  /** 发送：无会话自动创建；流式渲染回答（token 增量 + 角标） */
  async function handleSend() {
    const content = input.trim();
    if (!content || streaming) return;
    setError('');
    let convId = activeId;
    if (!convId) {
      try {
        const res = await apiFetch('/api/agent/conversations', {
          method: 'POST',
          schema: AgentConversationSchema,
        });
        convId = res.id;
        setActiveId(convId);
        await loadConversations();
      } catch (err) {
        setError(errorMessage(err));
        return;
      }
    }
    const currentId = convId;
    setInput('');
    setStreaming(true);
    setStreamingAnswer('');
    setStreamingCitations([]);
    // 立即回显用户消息
    setMessages((prev) => [
      ...prev,
      { id: `tmp-${Date.now()}`, role: 'user', content, citations: [], createdAt: new Date().toISOString() },
    ]);
    try {
      await streamChat(currentId, content, {
        onCitations: (c) => setStreamingCitations(c),
        onDelta: (delta) => setStreamingAnswer((prev) => prev + delta),
        onDone: (message) => {
          setStreamingAnswer('');
          setStreamingCitations([]);
          setMessages((prev) => [...prev.filter((m) => !m.id.startsWith('tmp-')), message]);
          void loadConversations(); // 标题/时间刷新
        },
      });
    } catch (err) {
      setError(errorMessage(err));
      setStreamingAnswer('');
      setStreamingCitations([]);
    } finally {
      setStreaming(false);
    }
  }

  useEffect(() => {
    void loadConversations();
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streamingAnswer]);

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <p>
        <Link href="/">← 返回首页</Link>
      </p>
      <h2>AI 客服</h2>
      <p style={{ color: '#6b7280', fontSize: 13 }}>
        基于知识库的客服助手：回答带 [n] 引用角标，点击跳转原文；支持多轮追问与会话回看/继续
      </p>
      {error && <p style={{ color: '#b91c1c' }}>{error}</p>}

      <div style={{ display: 'flex', gap: 16, marginTop: 12, alignItems: 'stretch' }}>
        {/* 会话列表 */}
        <aside style={{ width: 240, flexShrink: 0 }}>
          <button type="button" onClick={() => void handleNew()} style={{ width: '100%' }}>
            新建会话
          </button>
          {conversations.length === 0 ? (
            <p style={{ color: '#9ca3af', fontSize: 13, marginTop: 8 }}>暂无会话——点「新建会话」开始提问</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, marginTop: 8, display: 'grid', gap: 4 }}>
              {conversations.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => void openConversation(c.id)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      background: c.id === activeId ? '#eff6ff' : 'transparent',
                      border: c.id === activeId ? '1px solid #bfdbfe' : '1px solid #e5e7eb',
                      borderRadius: 8,
                      padding: '8px 10px',
                    }}
                  >
                    <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.title}
                    </span>
                    <span style={{ color: '#9ca3af', fontSize: 12 }}>
                      {new Date(c.updatedAt).toLocaleString('zh-CN')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* 聊天面板 */}
        <section
          style={{
            flex: 1,
            border: '1px solid #e5e7eb',
            borderRadius: 12,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 480,
            maxHeight: 640,
          }}
        >
          <div
            ref={listRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: 16,
              display: 'grid',
              gap: 12,
              alignContent: 'start',
            }}
          >
            {messages.length === 0 && !streaming ? (
              <p style={{ color: '#9ca3af' }}>开始提问吧——例如「如何登录？」</p>
            ) : (
              <>
                {messages.map((m) => (
                  <MessageBubble key={m.id} message={m} />
                ))}
                {streaming && (
                  <div
                    style={{
                      alignSelf: 'flex-start',
                      maxWidth: '80%',
                      padding: '8px 12px',
                      borderRadius: 12,
                      background: '#f9fafb',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    <AnswerText answer={streamingAnswer} citations={streamingCitations} />
                    {streamingAnswer === '' && <span style={{ color: '#9ca3af' }}>思考中…</span>}
                  </div>
                )}
              </>
            )}
          </div>
          <div style={{ padding: 12, borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSend();
              }}
              placeholder={streaming ? '回答中…' : '输入问题（Enter 发送）'}
              disabled={streaming}
              style={{ flex: 1 }}
            />
            <button type="button" onClick={() => void handleSend()} disabled={streaming}>
              {streaming ? '回答中…' : '发送'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

/** 消息气泡：user 右对齐、assistant 左对齐 + 引用角标行 */
function MessageBubble({ message }: { message: AgentMessage }) {
  const isUser = message.role === 'user';
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '80%',
          padding: '8px 12px',
          borderRadius: 12,
          background: isUser ? '#2563eb' : '#f9fafb',
          color: isUser ? '#fff' : 'inherit',
          whiteSpace: 'pre-wrap',
        }}
      >
        {isUser ? (
          message.content
        ) : (
          <AnswerText answer={message.content} citations={message.citations} />
        )}
      </div>
    </div>
  );
}

/** 回答渲染：纯文本分段 + [n] 角标（点击跳转原文） */
function AnswerText({ answer, citations }: { answer: string; citations: AgentCitation[] }) {
  const segments = splitAnswerWithCitations(answer);
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.citationIndex === null) {
          return <span key={i}>{seg.text}</span>;
        }
        const citation = citations.find((c) => c.index === seg.citationIndex);
        const url = citation ? citationUrl(citation) : null;
        const badge = (
          <sup
            style={{
              fontSize: 11,
              marginLeft: 2,
              padding: '0 4px',
              borderRadius: 999,
              background: '#dbeafe',
              color: '#1d4ed8',
              cursor: url ? 'pointer' : 'default',
            }}
          >
            [{seg.citationIndex}]
          </sup>
        );
        if (url && citation) {
          return (
            <a key={i} href={url} title={citation.title} style={{ textDecoration: 'none' }}>
              {badge}
            </a>
          );
        }
        return <span key={i}>{badge}</span>;
      })}
      {citations.length > 0 && (
        <span style={{ display: 'block', marginTop: 6, fontSize: 12, color: '#6b7280' }}>
          来源：{citations.map((c) => c.title).join('、')}
        </span>
      )}
    </>
  );
}
