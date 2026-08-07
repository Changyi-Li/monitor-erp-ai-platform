'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  ImportFetchRunResponseSchema,
  ImportPushResponseSchema,
  ImportStagedListResponseSchema,
  type ImportFetchRunResponse,
  type ImportPushResponse,
  type ImportStaged,
  type ImportStagedListResponse,
} from '@monitor/contracts';
import { KB_CATEGORY_LABELS } from '../../lib/kb-labels';
import { apiFetch, errorMessage } from '../../lib/api';

/**
 * 导入调试页（issue #25 验收 demo path）：
 * - 推送表单：粘贴 Markdown / 拖拽上传文件 → POST /imports/documents（调试页通道 =
 *   Bearer JWT，同 x-api-key 通道行为）→ 显示暂存记录 id + 判重标记（duplicated）
 * - 删除表单：外部源 sourceKey → 推送 delete（硬删除 + RAG 移除）
 * - 「立即拉取」：手动触发一次定时拉取（POST /imports/fetch/run）→ 汇总 fetched/staged/deleted
 * - 暂存记录表：3s 轮询刷新（pending→processing→processed/failed 流转可见）；
 *   documentId 非空 → 链到知识库详情人工发布（发布后复用 #21 管线进内部 Index）
 * 内部专属（kb:edit）；客户用户访问后端 403 兜底。
 */

/** 拖拽上传取文件（demo path，同 kb 页） */
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

const STAGED_STATUS_COLORS: Record<ImportStaged['status'], string> = {
  pending: '#b45309', // 琥珀
  processing: '#1d4ed8', // 蓝
  processed: '#15803d', // 绿
  failed: '#b91c1c', // 红
};

const STAGED_STATUS_LABELS: Record<ImportStaged['status'], string> = {
  pending: '待处理',
  processing: '处理中',
  processed: '已完成',
  failed: '失败',
};

export default function ImportPage() {
  const [records, setRecords] = useState<ImportStagedListResponse | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [pushing, setPushing] = useState(false);
  const [pushingDelete, setPushingDelete] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchResult, setFetchResult] = useState<ImportFetchRunResponse | null>(null);
  const [pushed, setPushed] = useState<ImportPushResponse | null>(null);
  const [dragging, setDragging] = useState(false);
  // 推送表单：markdown 或文件（拖拽）
  const [form, setForm] = useState({
    sourceKey: '',
    title: '',
    category: 'manual',
    docType: 'markdown' as 'markdown' | 'file',
    body: '',
    fileName: '',
    contentType: '',
    base64: '',
  });
  const [deleteForm, setDeleteForm] = useState({ sourceKey: '' });

  async function load() {
    try {
      const res = await apiFetch('/api/imports/staged', {
        schema: ImportStagedListResponseSchema,
      });
      setRecords(res);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000); // 状态流转实时刷新
    return () => clearInterval(t);
  }, []);

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

  /** 推送 upsert（Markdown 或文件，模拟外部项目 x-api-key 通道；JWT 调试页通道行为一致） */
  async function handlePush(e: React.FormEvent) {
    e.preventDefault();
    setActionError('');
    setPushed(null);
    setPushing(true);
    try {
      const body =
        form.docType === 'markdown'
          ? {
              action: 'upsert' as const,
              sourceKey: form.sourceKey,
              docType: 'markdown' as const,
              title: form.title,
              category: form.category,
              body: form.body,
            }
          : {
              action: 'upsert' as const,
              sourceKey: form.sourceKey,
              docType: 'file' as const,
              title: form.title,
              category: form.category,
              fileName: form.fileName,
              contentType: form.contentType,
              base64: form.base64,
            };
      const res = await apiFetch('/api/imports/documents', {
        method: 'POST',
        body,
        schema: ImportPushResponseSchema,
      });
      setPushed(res);
      setForm({ sourceKey: '', title: '', category: 'manual', docType: 'markdown', body: '', fileName: '', contentType: '', base64: '' });
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setPushing(false);
    }
  }

  /** 推送 delete（外部源移除文档 → 硬删除 + RAG 删除入队） */
  async function handleDelete(e: React.FormEvent) {
    e.preventDefault();
    if (!window.confirm(`确认推送删除「${deleteForm.sourceKey}」？将从知识库移除（含已发布内容）并同步删除 Index。`)) {
      return;
    }
    setActionError('');
    setPushingDelete(true);
    try {
      const res = await apiFetch('/api/imports/documents', {
        method: 'POST',
        body: { action: 'delete', sourceKey: deleteForm.sourceKey },
        schema: ImportPushResponseSchema,
      });
      setPushed(res);
      setDeleteForm({ sourceKey: '' });
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setPushingDelete(false);
    }
  }

  /** 手动触发一次定时拉取（配置了 IMPORT_FETCH_URL 时立即同步外部源清单） */
  async function handleFetchRun() {
    setActionError('');
    setFetchResult(null);
    setFetching(true);
    try {
      const res = await apiFetch('/api/imports/fetch/run', {
        method: 'POST',
        schema: ImportFetchRunResponseSchema,
      });
      setFetchResult(res);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setFetching(false);
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
        <h2>导入调试台</h2>
        <button type="button" onClick={() => void handleFetchRun()} disabled={fetching}>
          {fetching ? '拉取中…' : '立即拉取'}
        </button>
        {fetchResult && (
          <span style={{ color: '#15803d', fontSize: 13 }}>
            拉取完成：清单 {fetchResult.fetched} 条 · 新入队/变更 {fetchResult.staged} 条 · 派生删除{' '}
            {fetchResult.deleted} 条
          </span>
        )}
      </div>
      <p style={{ color: '#6b7280', fontSize: 13 }}>
        Online help 导入（spec §4.4）：外部推送 / 定时拉取 → 暂存队列（指纹去重）→ 自动落草稿
        → 人工发布后复用发布即同步管线进内部 Index；导入文档只读（在线编辑禁用）
      </p>
      {actionError && <p style={{ color: '#b91c1c' }}>{actionError}</p>}

      {/* 推送表单 */}
      <section style={{ marginTop: 16 }}>
        <h3>推送文档（upsert）</h3>
        <form
          onSubmit={handlePush}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: 12,
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            background: '#f9fafb',
          }}
        >
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 13, color: '#6b7280' }}>
              sourceKey：
              <input
                value={form.sourceKey}
                onChange={(e) => setForm({ ...form, sourceKey: e.target.value })}
                style={{ marginLeft: 4, minWidth: 200 }}
                placeholder="外部唯一键（如 help/docs/order-flow）"
              />
            </label>
            <label style={{ fontSize: 13, color: '#6b7280' }}>
              形态：
              <select
                value={form.docType}
                onChange={(e) => setForm({ ...form, docType: e.target.value as 'markdown' | 'file' })}
                style={{ marginLeft: 4 }}
              >
                <option value="markdown">Markdown / HTML 文本</option>
                <option value="file">上传文件（PDF/Word 等）</option>
              </select>
            </label>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 13, color: '#6b7280' }}>
              标题：
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                style={{ marginLeft: 4, minWidth: 260 }}
                placeholder="必填"
              />
            </label>
            <label style={{ fontSize: 13, color: '#6b7280' }}>
              分类：
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                style={{ marginLeft: 4 }}
              >
                {Object.entries(KB_CATEGORY_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {form.docType === 'markdown' ? (
            <div>
              <label style={{ color: '#6b7280', fontSize: 13 }}>正文（Markdown，HTML 同通道）：</label>
              <textarea
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                rows={8}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: 13, marginTop: 4 }}
                placeholder="# 标题&#10;&#10;外部文档内容（渲染 escape-first）"
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
                  id="import-create-file"
                />
                <label htmlFor="import-create-file" style={{ cursor: 'pointer', textDecoration: 'underline' }}>
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
                pushing ||
                !form.sourceKey.trim() ||
                !form.title.trim() ||
                (form.docType === 'file' && !form.base64)
              }
            >
              {pushing ? '推送中…' : '推送（落草稿）'}
            </button>
          </div>
        </form>
        {pushed && (
          <p style={{ marginTop: 8, fontSize: 13 }}>
            已入队：暂存 id{' '}
            <code style={{ background: '#f3f4f6', padding: '1px 4px', borderRadius: 4 }}>
              {pushed.record.id.slice(0, 8)}
              …
            </code>{' '}
            · 状态 {STAGED_STATUS_LABELS[pushed.record.status]}
            {pushed.duplicated && (
              <span style={{ color: '#b45309' }}> —— 与上次推送内容相同（判重跳过，未重复入队）</span>
            )}
          </p>
        )}
      </section>

      {/* 删除表单 */}
      <section style={{ marginTop: 16 }}>
        <h3>推送删除（delete）</h3>
        <form onSubmit={handleDelete} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={deleteForm.sourceKey}
            onChange={(e) => setDeleteForm({ sourceKey: e.target.value })}
            style={{ minWidth: 260 }}
            placeholder="外部唯一键（sourceKey）"
          />
          <button type="submit" disabled={pushingDelete || !deleteForm.sourceKey.trim()} style={{ color: '#b91c1c' }}>
            {pushingDelete ? '推送中…' : '推送删除'}
          </button>
        </form>
      </section>

      {/* 暂存记录表（3s 轮询：pending → processing → processed/failed 流转） */}
      <section style={{ marginTop: 20 }}>
        <h3>暂存记录（导入队列）</h3>
        {!records || records.records.length === 0 ? (
          <p style={{ color: '#9ca3af' }}>暂无暂存记录——推送或拉取后这里会显示增量/去重明细</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
            {records.records.map((r) => (
              <li
                key={r.id}
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
                    color: STAGED_STATUS_COLORS[r.status],
                  }}
                >
                  {STAGED_STATUS_LABELS[r.status]}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: r.source === 'api' ? '#eff6ff' : '#f0fdf4',
                    color: r.source === 'api' ? '#1d4ed8' : '#15803d',
                  }}
                >
                  {r.source === 'api' ? 'API 推送' : '定时拉取'}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: r.action === 'delete' ? '#fef2f2' : '#fffbeb',
                    color: r.action === 'delete' ? '#b91c1c' : '#b45309',
                  }}
                >
                  {r.action === 'delete' ? '删除' : '写入'}
                </span>
                <span style={{ fontWeight: 500 }}>
                  {r.action === 'delete' ? (
                    r.sourceKey
                  ) : r.documentId ? (
                    <Link href={`/kb/${r.documentId}`} style={{ color: '#2563eb' }}>
                      {r.title}
                    </Link>
                  ) : (
                    r.title
                  )}
                </span>
                {r.action !== 'delete' && (
                  <span style={{ color: '#6b7280', fontSize: 13 }}>
                    {r.docType === 'markdown' ? 'Markdown' : '文件'}
                    {r.fileName ? ` · ${r.fileName}` : ''}
                  </span>
                )}
                <span style={{ color: '#9ca3af', fontSize: 12 }}>指纹 {r.fingerprint.slice(0, 8)}…</span>
                {r.duplicateCount > 0 && (
                  <span style={{ color: '#b45309', fontSize: 13 }}>判重跳过 {r.duplicateCount} 次</span>
                )}
                {r.attempt > 0 && (
                  <span style={{ color: '#b45309', fontSize: 13 }}>重试 {r.attempt} 次</span>
                )}
                {r.lastError && (
                  <span style={{ color: '#b91c1c', fontSize: 13 }}>错误：{r.lastError}</span>
                )}
                <span style={{ color: '#9ca3af', fontSize: 12, marginLeft: 'auto' }}>
                  {new Date(r.updatedAt).toLocaleTimeString('zh-CN')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
