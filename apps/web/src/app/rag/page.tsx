'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  RagFailNextResponseSchema,
  RagIndexResponseSchema,
  RagSyncsResponseSchema,
  type RagIndexResponse,
  type RagSyncsResponse,
} from '@monitor/contracts';
import type { RagScope } from '@monitor/shared';
import { apiFetch, errorMessage } from '../../lib/api';
import {
  RAG_SCOPE_LABELS,
  RAG_SYNC_STATUS_COLORS,
  RAG_SYNC_STATUS_LABELS,
} from '../../lib/rag-labels';

/**
 * RAG 调试台（issue #21 验收④ demo path）：
 * - 同步任务面板：发布/归档/恢复 → 状态流转实时可见（排队→处理中→完成/失败，3s 轮询）
 * - fake Index 视图：按 scope（内部/客户）查看已导入文档——发布后可见、归档后消失
 * - 「制造一次失败」：注入后发布 → 面板看 failed → 指数退避自动重试 → 完成
 * 内部专属（rag:view）；客户用户访问后端 403 兜底。
 */

const TYPE_LABELS: Record<string, string> = { kb_document: '知识库文档', blueprint: '蓝图' };

export default function RagPage() {
  const [syncs, setSyncs] = useState<RagSyncsResponse | null>(null);
  const [index, setIndex] = useState<RagIndexResponse | null>(null);
  const [scope, setScope] = useState<RagScope>('internal');
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [failNextArmed, setFailNextArmed] = useState(false);

  async function loadSyncs() {
    try {
      const res = await apiFetch('/api/rag/syncs', { schema: RagSyncsResponseSchema });
      setSyncs(res);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function loadIndex() {
    try {
      const res = await apiFetch(`/api/rag/index?scope=${scope}`, {
        schema: RagIndexResponseSchema,
      });
      setIndex(res);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  useEffect(() => {
    void loadSyncs();
    const t = setInterval(() => void loadSyncs(), 3000); // 状态流转实时刷新
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void loadIndex();
  }, [scope]);

  /** 制造一次失败（demo path：注入 → 发布文档 → 观察失败 → 指数退避重试） */
  async function handleFailNext() {
    setActionError('');
    try {
      const res = await apiFetch('/api/rag/debug/fail-next', {
        method: 'POST',
        schema: RagFailNextResponseSchema,
      });
      setFailNextArmed(res.armed);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  if (error) {
    return (
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        <p style={{ color: '#b91c1c' }}>{error}</p>
        <Link href="/">← 返回首页</Link>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <p>
        <Link href="/">← 返回首页</Link>
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2>RAG 调试台</h2>
        <button type="button" onClick={() => void handleFailNext()}>
          制造一次失败
        </button>
        {failNextArmed && (
          <span style={{ color: '#b91c1c', fontSize: 13 }}>
            已武装——下一次同步导入将失败（观察指数退避重试）
          </span>
        )}
      </div>
      <p style={{ color: '#6b7280', fontSize: 13 }}>
        发布即同步管线（spec §4.3）：发布/归档/恢复 → 事务入队 → Worker 导入 fake Index；
        尝试「制造一次失败」后再发布文档，可看到 failed → 自动重试 → 已完成
      </p>
      {actionError && <p style={{ color: '#b91c1c' }}>{actionError}</p>}

      {/* 同步任务面板 */}
      <section style={{ marginTop: 16 }}>
        <h3>同步任务</h3>
        {!syncs || syncs.syncs.length === 0 ? (
          <p style={{ color: '#9ca3af' }}>暂无同步任务——发布或归档文档后这里会显示状态流转</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
            {syncs.syncs.map((s) => (
              <li
                key={s.id}
                style={{
                  padding: '8px 12px',
                  border: '1px solid #e5e7eb',
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: '#f3f4f6',
                    color: RAG_SYNC_STATUS_COLORS[s.status],
                  }}
                >
                  {RAG_SYNC_STATUS_LABELS[s.status]}
                </span>
                <span style={{ fontWeight: 500 }}>{s.title}</span>
                <span style={{ color: '#6b7280', fontSize: 13 }}>
                  {TYPE_LABELS[s.documentType]} · {s.action === 'upsert' ? '导入' : '删除'} v{s.versionNumber}
                </span>
                <span style={{ color: '#6b7280', fontSize: 13 }}>{RAG_SCOPE_LABELS[s.scope]}</span>
                {s.attempt > 0 && (
                  <span style={{ color: '#b45309', fontSize: 13 }}>重试 {s.attempt} 次</span>
                )}
                {s.lastError && (
                  <span style={{ color: '#b91c1c', fontSize: 13 }}>错误：{s.lastError}</span>
                )}
                <span style={{ color: '#9ca3af', fontSize: 12, marginLeft: 'auto' }}>
                  {new Date(s.updatedAt).toLocaleTimeString('zh-CN')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* fake Index 可见性 */}
      <section style={{ marginTop: 20 }}>
        <h3>fake Index（已导入文档）</h3>
        <label style={{ fontSize: 13, color: '#6b7280' }}>
          范围：
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as RagScope)}
            style={{ marginLeft: 4 }}
          >
            {(Object.keys(RAG_SCOPE_LABELS) as RagScope[]).map((s) => (
              <option key={s} value={s}>
                {RAG_SCOPE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        {!index || index.documents.length === 0 ? (
          <p style={{ color: '#9ca3af', marginTop: 8 }}>该 Index 暂无文档</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8, marginTop: 8 }}>
            {index.documents.map((d) => (
              <li
                key={d.documentId}
                style={{
                  padding: '8px 12px',
                  border: '1px solid #e5e7eb',
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ fontWeight: 500 }}>{d.title}</span>
                <span style={{ color: '#6b7280', fontSize: 13 }}>v{d.versionNumber}</span>
                {d.contentType && (
                  <span style={{ color: '#6b7280', fontSize: 13 }}>{d.contentType}</span>
                )}
                <span style={{ color: '#9ca3af', fontSize: 12, marginLeft: 'auto' }}>
                  {new Date(d.updatedAt).toLocaleString('zh-CN')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
