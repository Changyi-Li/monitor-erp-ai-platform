'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  KbDocumentResponseSchema,
  KbVersionsResponseSchema,
  type KbDocumentDetail,
  type KbVersion,
  type KbVersionsResponse,
} from '@monitor/contracts';
import { renderMarkdownSafe } from '../../../lib/markdown';
import { KB_CATEGORY_LABELS, KB_STATUS_COLORS, KB_STATUS_LABELS } from '../../../lib/kb-labels';
import { apiFetch, errorMessage } from '../../../lib/api';
import { getAccessToken } from '../../../lib/token-store';

/**
 * 知识库文档详情 + 编辑（issue #19 验收④）：
 * - 详情：markdown 渲染（escape-first 渲染器）/ 文件下载（fetch blob + a.click）+ 图片预览
 * - 内部：分栏编辑（左写右实时预览，demo path）、文件覆盖上传（拖拽）、发布/归档/恢复、
 *   版本历史（发布版本 + 当前草稿 + 回看）
 * - 客户用户：只读（无操作入口；后端 403 兜底）
 */

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

export default function KbDocumentPage() {
  const { documentId } = useParams<{ documentId: string }>();
  const [data, setData] = useState<KbDocumentDetail | null>(null);
  const [versions, setVersions] = useState<KbVersionsResponse | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [versionView, setVersionView] = useState<{ id: string; html?: string; fileUrl?: string; name?: string } | null>(null);
  // 编辑表单（初始值在点击编辑时填充）
  const [form, setForm] = useState({ title: '', category: '', body: '' });
  // 文件覆盖上传
  const [fileForm, setFileForm] = useState({ fileName: '', contentType: '', base64: '' });

  const doc = data ?? null;
  const canManage = doc?.viewerRole === 'internal'; // kb:edit = 仅内部

  async function load() {
    try {
      const res = await apiFetch(`/api/kb/documents/${documentId}`, {
        schema: KbDocumentResponseSchema,
      });
      setData(res.document);
      setError('');
      if (res.document.viewerRole === 'internal') {
        const vs = await apiFetch(`/api/kb/documents/${documentId}/versions`, {
          schema: KbVersionsResponseSchema,
        });
        setVersions(vs);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useEffect(() => {
    if (!documentId) {
      return;
    }
    void load();
    setPreviewUrl(null);
    setVersionView(null);
  }, [documentId]);

  /** 文件下载（fetch blob 带 Authorization；window.open 会 401） */
  async function handleDownload() {
    if (!doc?.file) {
      return;
    }
    setActionError('');
    try {
      const res = await fetch(`/api/kb/documents/${documentId}/content`, {
        headers: { Authorization: `Bearer ${getAccessToken()}` },
      });
      if (!res.ok) {
        throw new Error(`下载失败（${res.status}）`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.file.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '下载失败');
    }
  }

  /** 图片附件 → blob URL 内联预览 */
  async function togglePreview() {
    if (!doc?.file) {
      return;
    }
    setActionError('');
    if (previewUrl) {
      setPreviewUrl(null);
      return;
    }
    try {
      const res = await fetch(`/api/kb/documents/${documentId}/content`, {
        headers: { Authorization: `Bearer ${getAccessToken()}` },
      });
      if (!res.ok) {
        throw new Error(`读取文件失败（${res.status}）`);
      }
      const blob = await res.blob();
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '读取文件失败');
    }
  }

  function startEdit() {
    if (!doc) {
      return;
    }
    setEditing(true);
    setForm({ title: doc.title, category: doc.category, body: doc.body ?? '' });
    setFileForm({ fileName: '', contentType: '', base64: '' });
  }

  /** 保存草稿（markdown：标题/分类/正文；文件：覆盖上传） */
  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setActionError('');
    setSaving(true);
    try {
      const body = doc?.docType === 'file' ? fileForm : form;
      await apiFetch(`/api/kb/documents/${documentId}`, {
        method: 'PATCH',
        body,
        schema: KbDocumentResponseSchema,
      });
      setEditing(false);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  /** 发布/归档/恢复 */
  async function handleAction(action: 'publish' | 'archive' | 'restore') {
    if (!doc) {
      return;
    }
    const tips = {
      publish: doc.status === 'draft' ? '发布该草稿？' : '重新发布（草稿版本转正，线上更新）？',
      archive: '归档该文档？归档后从列表下架，客户不可见。',
      restore: '恢复该文档（重新上架）？',
    };
    if (!window.confirm(tips[action])) {
      return;
    }
    setActionError('');
    try {
      await apiFetch(`/api/kb/documents/${documentId}/${action}`, {
        method: 'POST',
        schema: KbDocumentResponseSchema,
      });
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  /** 版本内容回看（markdown → 渲染；文件 → 下载） */
  async function viewVersion(v: KbVersion) {
    setActionError('');
    try {
      const res = await fetch(`/api/kb/documents/${documentId}/versions/${v.id}/content`, {
        headers: { Authorization: `Bearer ${getAccessToken()}` },
      });
      if (!res.ok) {
        throw new Error(`读取失败（${res.status}）`);
      }
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        const json = (await res.json()) as { body: string };
        setVersionView({ id: v.id, html: renderMarkdownSafe(json.body) });
      } else {
        const blob = await res.blob();
        setVersionView({ id: v.id, fileUrl: URL.createObjectURL(blob), name: v.file?.name });
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '读取失败');
    }
  }

  async function handleFileDrop(file: File | undefined) {
    if (!file) {
      return;
    }
    try {
      const base64 = await readFileAsBase64(file);
      setFileForm({
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        base64,
      });
      setActionError('');
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  if (error) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <p style={{ color: '#b91c1c' }}>{error}</p>
        <Link href="/kb">← 返回知识库</Link>
      </div>
    );
  }
  if (!doc) {
    return <p style={{ textAlign: 'center', color: '#6b7280' }}>加载中…</p>;
  }

  const isImage = doc.file ? doc.file.contentType.startsWith('image/') : false;

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <p>
        <Link href="/kb">← 返回知识库</Link>
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2>{doc.title}</h2>
        <span
          style={{
            fontSize: 12,
            padding: '1px 8px',
            borderRadius: 999,
            background: '#f3f4f6',
            color: KB_STATUS_COLORS[doc.status],
          }}
        >
          {KB_STATUS_LABELS[doc.status]}
        </span>
        {doc.hasDraft && (
          <span
            style={{
              fontSize: 12,
              padding: '1px 8px',
              borderRadius: 999,
              background: '#fffbeb',
              color: '#b45309',
            }}
          >
            有待发布修改
          </span>
        )}
        {doc.source === 'online_help' && (
          <span
            style={{
              fontSize: 12,
              padding: '1px 8px',
              borderRadius: 999,
              background: '#eff6ff',
              color: '#1d4ed8',
            }}
          >
            外部 · 只读
          </span>
        )}
        {/* 外部导入文档只读（issue #25 AC3）：在线编辑禁用，发布/归档/恢复保留（人工发布后进 RAG） */}
        {canManage && !editing && doc.source !== 'online_help' && (
          <button type="button" onClick={startEdit}>
            编辑
          </button>
        )}
        {canManage && doc.status === 'draft' && (
          <button type="button" onClick={() => void handleAction('publish')}>
            发布
          </button>
        )}
        {canManage && doc.status === 'published' && (
          <>
            <button type="button" onClick={() => void handleAction('publish')}>
              {doc.hasDraft ? '重新发布' : '发布'}
            </button>
            <button type="button" style={{ color: '#b91c1c' }} onClick={() => void handleAction('archive')}>
              归档
            </button>
          </>
        )}
        {canManage && doc.status === 'archived' && (
          <button type="button" onClick={() => void handleAction('restore')}>
            恢复
          </button>
        )}
      </div>
      <p style={{ color: '#6b7280', marginTop: 4, fontSize: 13 }}>
        {KB_CATEGORY_LABELS[doc.category]} · {doc.docType === 'markdown' ? 'Markdown' : '文件'} ·
        创建人：{doc.createdBy?.displayName ?? '—'} · 更新于{' '}
        {new Date(doc.updatedAt).toLocaleString('zh-CN')}
      </p>
      {actionError && <p style={{ color: '#b91c1c' }}>{actionError}</p>}

      {/* 编辑视图（内部） */}
      {canManage && editing && (
        <form
          onSubmit={handleSave}
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
            <label style={{ color: '#6b7280', fontSize: 13 }}>标题：</label>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              style={{ marginLeft: 8, minWidth: 260 }}
              required
            />
          </div>
          <div>
            <label style={{ color: '#6b7280', fontSize: 13 }}>分类：</label>
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              style={{ marginLeft: 8 }}
            >
              {Object.entries(KB_CATEGORY_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {doc.docType === 'markdown' ? (
            <>
              <p style={{ color: '#6b7280', fontSize: 12, margin: 0 }}>
                Markdown 分栏编辑（左侧书写、右侧实时预览）
                {doc.status === 'published' && '——编辑已发布文档将生成新草稿版本，重新发布才生效'}
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <textarea
                  value={form.body}
                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                  rows={16}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
                />
                <div
                  dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(form.body) }}
                  style={{
                    border: '1px solid #e5e7eb',
                    borderRadius: 8,
                    padding: 8,
                    overflowY: 'auto',
                    maxHeight: 340,
                    background: '#fff',
                  }}
                />
              </div>
            </>
          ) : (
            <div>
              <p style={{ color: '#6b7280', fontSize: 12, margin: '0 0 4px' }}>
                文件类文档不支持在线编辑（spec §4.1「上传 + 覆盖更新」）；覆盖上传后将生成新草稿版本
              </p>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  void handleFileDrop(e.dataTransfer.files?.[0]);
                }}
                style={{
                  padding: 16,
                  border: `2px dashed ${dragging ? '#2563eb' : '#d1d5db'}`,
                  borderRadius: 8,
                  textAlign: 'center',
                  color: dragging ? '#2563eb' : '#6b7280',
                  fontSize: 13,
                }}
              >
                <input
                  type="file"
                  onChange={(e) => void handleFileDrop(e.target.files?.[0])}
                  style={{ display: 'none' }}
                  id="kb-edit-file"
                />
                <label htmlFor="kb-edit-file" style={{ cursor: 'pointer', textDecoration: 'underline' }}>
                  选择文件
                </label>{' '}
                或拖拽到此处
                {fileForm.fileName && <p style={{ marginTop: 8, color: '#111827' }}>{fileForm.fileName}</p>}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="submit"
              disabled={
                saving ||
                !form.title.trim() ||
                (doc.docType === 'file' && !fileForm.base64)
              }
            >
              {saving ? '保存中…' : '保存草稿'}
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </form>
      )}

      {/* 正文区 */}
      {doc.docType === 'markdown' ? (
        doc.body ? (
          <section style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginTop: 8 }}>
            <div dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(doc.body) }} />
          </section>
        ) : (
          <p style={{ color: '#9ca3af' }}>（暂无正文）</p>
        )
      ) : doc.file ? (
        <section
          style={{
            marginTop: 8,
            padding: 12,
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontWeight: 500 }}>{doc.file.name}</span>
          <span style={{ color: '#6b7280', fontSize: 13 }}>{(doc.file.size / 1024).toFixed(1)} KB</span>
          <span style={{ color: '#6b7280', fontSize: 13 }}>{doc.file.contentType}</span>
          <button type="button" onClick={() => void handleDownload()}>
            下载
          </button>
          {isImage && (
            <button type="button" onClick={() => void togglePreview()}>
              {previewUrl ? '收起预览' : '预览'}
            </button>
          )}
          {previewUrl && <img src={previewUrl} alt={doc.file.name} style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 8 }} />}
        </section>
      ) : (
        <p style={{ color: '#9ca3af' }}>（暂无内容）</p>
      )}

      {/* 版本历史（内部） */}
      {canManage && versions && (
        <section style={{ marginTop: 20 }}>
          <h3>版本历史</h3>
          {versions.versions.length === 0 ? (
            <p style={{ color: '#9ca3af' }}>暂无版本。</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
              {versions.versions.map((v) => (
                <li
                  key={v.id}
                  style={{
                    padding: '8px 10px',
                    border: '1px solid #e5e7eb',
                    borderRadius: 8,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <span style={{ fontWeight: 500 }}>
                    {v.versionNumber === null ? '草稿（未发布）' : `v${v.versionNumber}`}
                  </span>
                  <span style={{ color: '#6b7280', fontSize: 13 }}>{v.title}</span>
                  {v.versionNumber !== null && (
                    <span style={{ color: '#6b7280', fontSize: 13 }}>
                      发布人：{v.publishedBy?.displayName ?? '—'} ·{' '}
                      {v.publishedAt ? new Date(v.publishedAt).toLocaleString('zh-CN') : ''}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void viewVersion(v)}
                    style={{ marginLeft: 'auto' }}
                  >
                    查看内容
                  </button>
                </li>
              ))}
            </ul>
          )}
          {versionView && (
            <div style={{ marginTop: 8, border: '1px solid #e5e7eb', borderRadius: 8, padding: 12 }}>
              {versionView.html !== undefined ? (
                <div dangerouslySetInnerHTML={{ __html: versionView.html }} />
              ) : versionView.fileUrl ? (
                <a href={versionView.fileUrl} download={versionView.name}>
                  下载该版本文件（{versionView.name}）
                </a>
              ) : null}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
