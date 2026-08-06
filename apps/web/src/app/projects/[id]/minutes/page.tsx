'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  MinuteResponseSchema,
  MinutesListResponseSchema,
  type MeetingMinute,
} from '@monitor/contracts';
import RichTextEditor from '../../../../components/rich-text-editor';
import { apiFetch, errorMessage } from '../../../../lib/api';

/**
 * 会议纪要列表（issue #18 验收 ④ 前端）：
 * - 内部（实施）：新建纪要（结构化字段 + 富文本编辑器所见即所得）
 * - 全员：列表（主题/日期/参会人/附件数/创建人）→ 详情页
 * - 客户用户：只读列表（无新建入口；后端 403 兜底）
 */
export default function MinutesPage() {
  const { id } = useParams<{ id: string }>();
  const [minutes, setMinutes] = useState<MeetingMinute[] | null>(null);
  const [viewerRole, setViewerRole] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  // 新建表单
  const [form, setForm] = useState({ title: '', meetingDate: '', participants: '', body: '' });

  const canManage = viewerRole === 'internal'; // spec §2.4：会议纪要维护仅内部

  async function load() {
    try {
      const res = await apiFetch(`/api/projects/${id}/minutes`, {
        schema: MinutesListResponseSchema,
      });
      setMinutes(res.minutes);
      setViewerRole(res.viewerRole);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useEffect(() => {
    if (!id) {
      return;
    }
    void load();
  }, [id]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setActionError('');
    setSaving(true);
    try {
      await apiFetch(`/api/projects/${id}/minutes`, {
        method: 'POST',
        body: {
          title: form.title,
          meetingDate: form.meetingDate,
          participants: form.participants || undefined,
          body: form.body || undefined,
        },
        schema: MinuteResponseSchema,
      });
      setForm({ title: '', meetingDate: '', participants: '', body: '' });
      setCreating(false);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <p style={{ color: '#b91c1c' }}>{error}</p>
        <Link href={`/projects/${id}`}>← 返回项目详情</Link>
      </div>
    );
  }
  if (!minutes) {
    return <p style={{ textAlign: 'center', color: '#6b7280' }}>加载中…</p>;
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <p>
        <Link href={`/projects/${id}`}>← 返回项目详情</Link>
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2>会议纪要</h2>
        {canManage && !creating && (
          <button type="button" onClick={() => setCreating(true)}>
            新建纪要
          </button>
        )}
        {canManage && creating && (
          <button type="button" onClick={() => setCreating(false)}>
            取消
          </button>
        )}
      </div>
      {actionError && <p style={{ color: '#b91c1c' }}>{actionError}</p>}

      {canManage && creating && (
        <form
          onSubmit={handleCreate}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: 12,
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            marginBottom: 16,
            background: '#f9fafb',
          }}
        >
          <div>
            <label style={{ color: '#6b7280', fontSize: 13 }}>主题：</label>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              style={{ marginLeft: 8, minWidth: 260 }}
              placeholder="必填"
            />
          </div>
          <div>
            <label style={{ color: '#6b7280', fontSize: 13 }}>会议日期：</label>
            <input
              type="date"
              value={form.meetingDate}
              onChange={(e) => setForm({ ...form, meetingDate: e.target.value })}
              style={{ marginLeft: 8 }}
              required
            />
          </div>
          <div>
            <label style={{ color: '#6b7280', fontSize: 13 }}>参会人：</label>
            <input
              value={form.participants}
              onChange={(e) => setForm({ ...form, participants: e.target.value })}
              style={{ marginLeft: 8, minWidth: 260 }}
              placeholder="张三、李四…"
            />
          </div>
          <div>
            <label style={{ color: '#6b7280', fontSize: 13 }}>正文（富文本）：</label>
            <div style={{ marginTop: 4 }}>
              <RichTextEditor
                value={form.body}
                onChange={(html) => setForm({ ...form, body: html })}
              />
            </div>
          </div>
          <div>
            <button type="submit" disabled={saving || !form.title.trim() || !form.meetingDate}>
              {saving ? '创建中…' : '创建纪要'}
            </button>
          </div>
        </form>
      )}

      {minutes.length === 0 ? (
        <p style={{ color: '#6b7280' }}>
          该项目还没有会议纪要，{canManage ? '点击「新建纪要」记录第一次会议' : '请等待内部用户创建'}。
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {minutes.map((m) => (
            <li
              key={m.id}
              style={{
                padding: '10px 12px',
                border: '1px solid #e5e7eb',
                borderRadius: 8,
              }}
            >
              <div style={{ fontWeight: 600 }}>
                <Link href={`/projects/${id}/minutes/${m.id}`} style={{ color: '#2563eb' }}>
                  {m.title}
                </Link>
              </div>
              <div style={{ color: '#6b7280', fontSize: 13, marginTop: 2 }}>
                {m.meetingDate} · {m.participants ?? '（无参会人）'} · 附件{' '}
                {m.attachments.length} 个 · 创建人：{m.createdBy?.displayName ?? '—'} ·{' '}
                {new Date(m.updatedAt).toLocaleString('zh-CN')}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
