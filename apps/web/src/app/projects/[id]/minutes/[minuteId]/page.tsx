'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  AttachmentResponseSchema,
  MinuteGetResponseSchema,
  MinuteResponseSchema,
  type Attachment,
  type MeetingMinute,
  type MinuteGetResponse,
} from '@monitor/contracts';
import RichTextEditor from '../../../../../components/rich-text-editor';
import { apiFetch, errorMessage } from '../../../../../lib/api';
import { getAccessToken } from '../../../../../lib/token-store';

/** 图片附件 → blob URL 内联预览；其余类型 → 下载（fetch blob + a.click，Authorization 头不能丢） */
function isImage(a: Attachment): boolean {
  return a.contentType.startsWith('image/');
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = reader.result as string;
      resolve(data.slice(data.indexOf(',') + 1)); // 去 dataURL 前缀
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 会议纪要详情（issue #18 验收 ④ 前端）：
 * - 富文本正文渲染（body 为内部生成的 HTML）+ 附件：图片内联预览、其余下载
 * - 内部（实施）：上传附件、删除附件、编辑纪要（富文本编辑器）、删除纪要
 * - 客户用户：只读查看 + 附件下载/预览（无操作入口；后端 403 兜底）
 */
export default function MinuteDetailPage() {
  const { id, minuteId } = useParams<{ id: string; minuteId: string }>();
  const [data, setData] = useState<MinuteGetResponse | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [editing, setEditing] = useState(false);
  // 编辑表单（初始值在点击编辑时填充）
  const [form, setForm] = useState({ title: '', meetingDate: '', participants: '', body: '' });
  // 图片预览 blob URL（按附件 id 缓存，切换详情时清空）
  const [previews, setPreviews] = useState<Map<string, string>>(new Map());
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const viewerRole = data?.viewerRole ?? null;
  const canManage = viewerRole === 'internal'; // spec §2.4：会议纪要维护仅内部

  async function load() {
    try {
      const res = await apiFetch(`/api/projects/${id}/minutes/${minuteId}`, {
        schema: MinuteGetResponseSchema,
      });
      setData(res);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useEffect(() => {
    if (!id || !minuteId) {
      return;
    }
    void load();
    setPreviews(new Map());
  }, [id, minuteId]);

  /** 下载：fetch blob（带 Authorization）→ a.click；图片走预览分支 */
  async function handleDownload(attachment: Attachment) {
    setDownloadingId(attachment.id);
    setActionError('');
    try {
      const res = await fetch(
        `/api/projects/${id}/minutes/${minuteId}/attachments/${attachment.id}/file`,
        { headers: { Authorization: `Bearer ${getAccessToken()}` } },
      );
      if (!res.ok) {
        throw new Error(`下载失败（${res.status}）`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = attachment.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '下载失败');
    } finally {
      setDownloadingId(null);
    }
  }

  /** 图片附件 → blob URL 预览（点击切换显示/隐藏） */
  async function togglePreview(attachment: Attachment) {
    setActionError('');
    if (previews.has(attachment.id)) {
      const next = new Map(previews);
      next.delete(attachment.id);
      setPreviews(next);
      return;
    }
    try {
      const res = await fetch(
        `/api/projects/${id}/minutes/${minuteId}/attachments/${attachment.id}/file`,
        { headers: { Authorization: `Bearer ${getAccessToken()}` } },
      );
      if (!res.ok) {
        throw new Error(`读取附件失败（${res.status}）`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setPreviews((prev) => new Map(prev).set(attachment.id, url));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '读取附件失败');
    }
  }

  async function handleUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fileInput = e.currentTarget.elements.namedItem('file') as HTMLInputElement;
    const file = fileInput?.files?.[0];
    if (!file) {
      return;
    }
    setUploadError('');
    setUploading(true);
    try {
      const base64 = await readFileAsBase64(file);
      await apiFetch(`/api/projects/${id}/minutes/${minuteId}/attachments`, {
        method: 'POST',
        body: { name: file.name, contentType: file.type || 'application/octet-stream', base64 },
        schema: AttachmentResponseSchema,
      });
      fileInput.value = '';
      await load();
    } catch (err) {
      setUploadError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  async function handleDeleteAttachment(attachmentId: string) {
    if (!window.confirm('删除该附件？')) {
      return;
    }
    setActionError('');
    try {
      await apiFetch<void>(
        `/api/projects/${id}/minutes/${minuteId}/attachments/${attachmentId}`,
        { method: 'DELETE' },
      );
      setPreviews((prev) => {
        const next = new Map(prev);
        next.delete(attachmentId);
        return next;
      });
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  function startEdit(minute: MeetingMinute) {
    setEditing(true);
    setForm({
      title: minute.title,
      meetingDate: minute.meetingDate,
      participants: minute.participants ?? '',
      body: minute.body ?? '',
    });
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    setActionError('');
    setSaving(true);
    try {
      await apiFetch(`/api/projects/${id}/minutes/${minuteId}`, {
        method: 'PATCH',
        body: {
          title: form.title,
          meetingDate: form.meetingDate,
          participants: form.participants || null,
          body: form.body || null,
        },
        schema: MinuteResponseSchema,
      });
      setEditing(false);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteMinute() {
    if (!window.confirm(`删除纪要「${data?.minute.title ?? ''}」？附件将一并删除。`)) {
      return;
    }
    setActionError('');
    try {
      await apiFetch<void>(`/api/projects/${id}/minutes/${minuteId}`, { method: 'DELETE' });
      window.location.href = `/projects/${id}/minutes`;
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  if (error) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <p style={{ color: '#b91c1c' }}>{error}</p>
        <Link href={`/projects/${id}/minutes`}>← 返回纪要列表</Link>
      </div>
    );
  }
  if (!data) {
    return <p style={{ textAlign: 'center', color: '#6b7280' }}>加载中…</p>;
  }

  const minute = data.minute;

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <p>
        <Link href={`/projects/${id}/minutes`}>← 返回纪要列表</Link>
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2>{minute.title}</h2>
        {canManage && !editing && (
          <button type="button" onClick={() => startEdit(minute)}>
            编辑
          </button>
        )}
        {canManage && (
          <button type="button" style={{ color: '#b91c1c' }} onClick={() => void handleDeleteMinute()}>
            删除纪要
          </button>
        )}
      </div>
      <p style={{ color: '#6b7280', marginTop: 4 }}>
        {minute.meetingDate} · 参会人：{minute.participants ?? '（无）'} · 创建人：
        {minute.createdBy?.displayName ?? '—'} · 更新于{' '}
        {new Date(minute.updatedAt).toLocaleString('zh-CN')}
      </p>
      {actionError && <p style={{ color: '#b91c1c' }}>{actionError}</p>}

      {canManage && editing && (
        <form
          onSubmit={handleSaveEdit}
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
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={saving || !form.title.trim() || !form.meetingDate}>
              {saving ? '保存中…' : '保存修改'}
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </form>
      )}

      {/* 富文本正文渲染（内部生成的 HTML；同源信任，见 ADR 0007） */}
      {minute.body ? (
        <section style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginTop: 8 }}>
          <div dangerouslySetInnerHTML={{ __html: minute.body }} />
        </section>
      ) : (
        <p style={{ color: '#9ca3af' }}>（暂无正文）</p>
      )}

      <section style={{ marginTop: 20 }}>
        <h3>附件（{minute.attachments.length}）</h3>
        {canManage && (
          <form
            onSubmit={(e) => void handleUpload(e)}
            style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}
          >
            <input type="file" name="file" />
            <button type="submit" disabled={uploading}>
              {uploading ? '上传中…' : '上传附件'}
            </button>
          </form>
        )}
        {uploadError && <p style={{ color: '#b91c1c' }}>{uploadError}</p>}
        {minute.attachments.length === 0 ? (
          <p style={{ color: '#9ca3af' }}>暂无附件。</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
            {minute.attachments.map((a) => (
              <li
                key={a.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  border: '1px solid #e5e7eb',
                  borderRadius: 8,
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ fontWeight: 500 }}>{a.name}</span>
                <span style={{ color: '#6b7280', fontSize: 13 }}>
                  {(a.size / 1024).toFixed(1)} KB
                </span>
                {isImage(a) && (
                  <button type="button" onClick={() => void togglePreview(a)}>
                    {previews.has(a.id) ? '收起预览' : '预览'}
                  </button>
                )}
                <button
                  type="button"
                  disabled={downloadingId === a.id}
                  onClick={() => void handleDownload(a)}
                >
                  {downloadingId === a.id ? '下载中…' : '下载'}
                </button>
                {canManage && (
                  <button
                    type="button"
                    style={{ color: '#b91c1c' }}
                    onClick={() => void handleDeleteAttachment(a.id)}
                  >
                    删除
                  </button>
                )}
                {previews.has(a.id) && (
                  <img
                    src={previews.get(a.id)}
                    alt={a.name}
                    style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 8 }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
