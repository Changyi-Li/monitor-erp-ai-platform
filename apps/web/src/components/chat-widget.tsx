'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AgentConversationSchema,
  AgentMessagesResponseSchema,
  type AgentCitation,
  type AgentMessage,
} from '@monitor/contracts';
import { apiFetch, errorMessage } from '../lib/api';
import { streamChat } from '../lib/agent';
import { citationUrl, splitAnswerWithCitations } from '../lib/agent-labels';
import { useAuth } from './auth-provider';

/**
 * AI 客服悬浮小组件（issue #22 验收④ demo path：任意页面右下角气泡 → 点开即聊）。
 * 仅内部用户渲染（agent:use）；打开时自动创建/继续最近会话；
 * 独立小组件不与其他页面共享 store，复用 streamChat 流式渲染逻辑。
 */

export function ChatWidget() {
  const { user, status } = useAuth();
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingAnswer, setStreamingAnswer] = useState('');
  const [streamingCitations, setStreamingCitations] = useState<AgentCitation[]>([]);
  const [error, setError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const internalOnly = status === 'authenticated' && !!user && user.role !== 'customer';

  /** 打开面板：无会话则自动创建（demo：点开即聊） */
  async function handleToggle() {
    const next = !open;
    setOpen(next);
    if (next && !conversationId) {
      try {
        const res = await apiFetch('/api/agent/conversations', {
          method: 'POST',
          schema: AgentConversationSchema,
        });
        setConversationId(res.id);
      } catch (err) {
        setError(errorMessage(err));
      }
    }
  }

  async function handleSend() {
    const content = input.trim();
    if (!content || streaming || !conversationId) return;
    setError('');
    setInput('');
    setStreaming(true);
    setStreamingAnswer('');
    setStreamingCitations([]);
    setMessages((prev) => [
      ...prev,
      { id: `tmp-${Date.now()}`, role: 'user', content, citations: [], createdAt: new Date().toISOString() },
    ]);
    try {
      await streamChat(conversationId, content, {
        onCitations: (c) => setStreamingCitations(c),
        onDelta: (delta) => setStreamingAnswer((prev) => prev + delta),
        onDone: (message) => {
          setStreamingAnswer('');
          setStreamingCitations([]);
          setMessages((prev) => [...prev.filter((m) => !m.id.startsWith('tmp-')), message]);
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
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streamingAnswer]);

  if (!internalOnly) return null;

  return (
    <>
      {/* 悬浮气泡（右下角） */}
      <button
        type="button"
        onClick={() => void handleToggle()}
        aria-label="AI 客服"
        style={{
          position: 'fixed',
          right: 20,
          bottom: 20,
          zIndex: 50,
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: '#2563eb',
          color: '#fff',
          fontSize: 22,
          border: 'none',
          cursor: 'pointer',
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
        }}
      >
        {open ? '✕' : '🤖'}
      </button>

      {/* 聊天面板 */}
      {open && (
        <div
          style={{
            position: 'fixed',
            right: 20,
            bottom: 88,
            zIndex: 50,
            width: 360,
            height: 480,
            border: '1px solid #e5e7eb',
            borderRadius: 12,
            background: '#fff',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
          }}
        >
          <div
            style={{
              padding: '10px 14px',
              borderBottom: '1px solid #e5e7eb',
              fontWeight: 600,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>AI 客服</span>
            <a href="/agent" style={{ fontSize: 12, color: '#2563eb' }}>
              完整页面 →
            </a>
          </div>
          <div
            ref={listRef}
            style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'grid', gap: 8, alignContent: 'start' }}
          >
            {messages.length === 0 && !streaming ? (
              <p style={{ color: '#9ca3af', fontSize: 13 }}>问点什么吧——例如「如何登录？」</p>
            ) : (
              <>
                {messages.map((m) => (
                  <div
                    key={m.id}
                    style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}
                  >
                    <div
                      style={{
                        maxWidth: '85%',
                        padding: '6px 10px',
                        borderRadius: 10,
                        fontSize: 14,
                        background: m.role === 'user' ? '#2563eb' : '#f3f4f6',
                        color: m.role === 'user' ? '#fff' : 'inherit',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {m.role === 'user' ? (
                        m.content
                      ) : (
                        <WidgetAnswer answer={m.content} citations={m.citations} />
                      )}
                    </div>
                  </div>
                ))}
                {streaming && (
                  <div style={{ maxWidth: '85%', padding: '6px 10px', borderRadius: 10, fontSize: 14, background: '#f3f4f6', whiteSpace: 'pre-wrap' }}>
                    <WidgetAnswer answer={streamingAnswer} citations={streamingCitations} />
                    {streamingAnswer === '' && <span style={{ color: '#9ca3af' }}>思考中…</span>}
                  </div>
                )}
              </>
            )}
            {error && <p style={{ color: '#b91c1c', fontSize: 12 }}>{error}</p>}
          </div>
          <div style={{ padding: 10, borderTop: '1px solid #e5e7eb', display: 'flex', gap: 6 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSend();
              }}
              placeholder={streaming ? '回答中…' : '输入问题'}
              disabled={streaming}
              style={{ flex: 1, fontSize: 14 }}
            />
            <button type="button" onClick={() => void handleSend()} disabled={streaming} style={{ fontSize: 14 }}>
              发送
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** 小组件回答渲染（复用页面相同的角标逻辑；简化版不带「来源」列表） */
function WidgetAnswer({ answer, citations }: { answer: string; citations: AgentCitation[] }) {
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
              fontSize: 10,
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
        if (url) {
          return (
            <a key={i} href={url} title={citation?.title} style={{ textDecoration: 'none' }}>
              {badge}
            </a>
          );
        }
        return <span key={i}>{badge}</span>;
      })}
    </>
  );
}
