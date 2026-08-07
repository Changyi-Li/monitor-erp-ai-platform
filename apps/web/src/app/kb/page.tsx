'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  KbDocumentResponseSchema,
  KbListResponseSchema,
  type KbDocument,
  type KbListResponse,
} from '@monitor/contracts';
import {
  KB_CATEGORY_LABELS,
  KB_SOURCE_LABELS,
  KB_STATUS_COLORS,
  KB_STATUS_LABELS,
} from '../../lib/kb-labels';
import { apiFetch, errorMessage } from '../../lib/api';

/**
 * 内部知识库列表（issue #19 验收④）：
 * - 分类筛选（操作手册/FAQ/最佳实践）+ 已归档管理视图（内部，includeArchived）
 * - 内部：新建文档（markdown 分栏编辑 / 文件拖拽上传）
 * - 客户用户：只读列表（仅已发布；无新建入口，后端 403 兜底）
 */

/** 拖拽上传取文件（demo path「拖拽上传 Word/PDF」） */
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

export default function KbPage() {
  const [data, setData] = useState<KbListResponse | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [category, setCategory] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  // 新建表单：markdown 或文件（拖拽）
  const [form, setForm] = useState({
    title: '',
    category: 'manual',
    docType: 'markdown' as 'markdown' | 'file',
    body: '',
    fileName: '',
    contentType: '',
    base64: '',
  });

  const viewerRole = data?.viewerRole ?? null;
  const canManage = viewerRole === 'internal'; // kb:edit = 仅内部（spec §2.4）

  async function load() {
    try {
      const query = new URLSearchParams();
      if (category) {
        query.set('category', category);
      }
      if (includeArchived) {
        query.set('includeArchived', 'true');
      }
      const qs = query.toString();
      const res = await apiFetch(`/api/kb/documents${qs ? `?${qs}` : ''}`, {
        schema: KbListResponseSchema,
      });
      setData(res);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useEffect(() => {
    void load();
  }, [category, includeArchived]);

  /** 文件拖拽：drop 后读取 base64 入表单 */
  async function handleFileDrop(file: File | undefined) {
    if (!file) {
      return;
    }
    try {
      const base64 = await readFileAsBase64(file);
      setForm({
        ...form,
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        base64,
      });
      setActionError('');
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setActionError('');
    setSaving(true);
    try {
      const body =
        form.docType === 'markdown'
          ? { docType: 'markdown' as const, title: form.title, category: form.category, body: form.body }
          : {
              docType: 'file' as const,
              title: form.title,
              category: form.category,
              fileName: form.fileName,
              contentType: form.contentType,
              base64: form.base64,
            };
      await apiFetch('/api/kb/documents', { method: 'POST', body, schema: KbDocumentResponseSchema });
      setForm({ title: '', category: 'manual', docType: 'markdown', body: '', fileName: '', contentType: '', base64: '' });
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
        <Link href="/projects">← 返回项目列表</Link>
      </div>
    );
  }
  if (!data) {
    return <p style={{ textAlign: 'center', color: '#6b7280' }}>加载中…</p>;
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <p>
        <Link href="/">← 返回首页</Link>
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2>知识库</h2>
        {canManage && !creating && (
          <button type="button" onClick={() => setCreating(true)}>
            新建文档
          </button>
        )}
        {canManage && creating && (
          <button type="button" onClick={() => setCreating(false)}>
            取消
          </button>
        )}
      </div>
      <p style={{ color: '#6b7280', fontSize: 13 }}>
        内部知识库（操作手册 / FAQ / 最佳实践）；客户用户可浏览已发布文档
      </p>

      {/* 筛选区 */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '12px 0', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, color: '#6b7280' }}>
          分类：
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ marginLeft: 4 }}>
            <option value="">全部</option>
            {Object.entries(KB_CATEGORY_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {canManage && (
          <label style={{ fontSize: 13, color: '#6b7280' }}>
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            显示已归档
          </label>
        )}
      </div>
      {actionError && <p style={{ color: '#b91c1c' }}>{actionError}</p>}

      {/* 新建表单（内部） */}
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
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 13, color: '#6b7280' }}>
              形态：
              <select
                value={form.docType}
                onChange={(e) => setForm({ ...form, docType: e.target.value as 'markdown' | 'file' })}
                style={{ marginLeft: 4 }}
              >
                <option value="markdown">在线 Markdown</option>
                <option value="file">上传文件（Word/PDF 等）</option>
              </select>
            </label>
          </div>
          <div>
            <label style={{ color: '#6b7280', fontSize: 13 }}>标题：</label>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              style={{ marginLeft: 8, minWidth: 260 }}
              placeholder="必填"
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
          {form.docType === 'markdown' ? (
            <div>
              <label style={{ color: '#6b7280', fontSize: 13 }}>正文（Markdown）：</label>
              <textarea
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                rows={8}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: 13, marginTop: 4 }}
                placeholder="# 标题&#10;&#10;支持 **粗体**、- 列表、``` 代码块 等"
              />
            </div>
          ) : (
            <div>
              <label style={{ color: '#6b7280', fontSize: 13 }}>文件（可拖拽上传）：</label>
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
                  marginTop: 4,
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
                  id="kb-create-file"
                />
                <label htmlFor="kb-create-file" style={{ cursor: 'pointer', textDecoration: 'underline' }}>
                  选择文件
                </label>{' '}
                或拖拽到此处
                {form.fileName && <p style={{ marginTop: 8, color: '#111827' }}>{form.fileName}</p>}
              </div>
            </div>
          )}
          <div>
            <button
              type="submit"
              disabled={
                saving ||
                !form.title.trim() ||
                (form.docType === 'file' && !form.base64)
              }
            >
              {saving ? '创建中…' : '创建草稿'}
            </button>
          </div>
        </form>
      )}

      {/* 文档列表 */}
      {data.documents.length === 0 ? (
        <p style={{ color: '#6b7280' }}>
          {includeArchived
            ? '没有已归档的文档。'
            : canManage
              ? '还没有文档，点击「新建文档」开始沉淀知识。'
              : '暂无已发布文档。'}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {data.documents.map((doc: KbDocument) => (
            <li
              key={doc.id}
              style={{
                padding: '10px 12px',
                border: '1px solid #e5e7eb',
                borderRadius: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600 }}>
                  <Link href={`/kb/${doc.id}`} style={{ color: '#2563eb' }}>
                    {doc.title}
                  </Link>
                </span>
                <span
                  style={{
                    fontSize: 12,
                    padding: '1px 8px',
                    borderRadius: 999,
                    background: '#f3f4f6',
                    color: '#374151',
                  }}
                >
                  {KB_CATEGORY_LABELS[doc.category]}
                </span>
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
                    {KB_SOURCE_LABELS[doc.source]}
                  </span>
                )}
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
              </div>
              <div style={{ color: '#6b7280', fontSize: 13, marginTop: 2 }}>
                {doc.docType === 'markdown' ? 'Markdown' : '文件'} · 创建人：
                {doc.createdBy?.displayName ?? '—'} · {new Date(doc.updatedAt).toLocaleString('zh-CN')}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
