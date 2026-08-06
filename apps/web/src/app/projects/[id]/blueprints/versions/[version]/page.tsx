'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BlueprintVersionGetResponseSchema, type BlueprintVersion } from '@monitor/contracts';
import { apiFetch, errorMessage } from '../../../../../../lib/api';
import { getAccessToken } from '../../../../../../lib/token-store';

/** 结构化文档字段（与蓝图主页同构） */
const FIELD_KEYS = [
  ['businessRequirements', '业务需求'],
  ['moduleScope', '模块 / 功能范围'],
  ['configNotes', '配置说明'],
  ['processDescription', '流程描述'],
] as const;

/**
 * 蓝图版本回看（issue #16 验收 ③ 前端）：
 * - 历史版本快照字段展示（不可变）
 * - 下载原文件（fetch blob + a.click，Authorization 头不能丢）
 * - 页面内预览 draw.io 原文件（本质 XML 文本）
 * - 客户用户可回看/下载（spec：查看全员；后端 403 兜底）
 */
export default function BlueprintVersionDetailPage() {
  const { id, version } = useParams<{ id: string; version: string }>();
  const [data, setData] = useState<BlueprintVersion | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  async function load() {
    try {
      const res = await apiFetch(`/api/projects/${id}/blueprints/versions/${version}`, {
        schema: BlueprintVersionGetResponseSchema,
      });
      setData(res.version);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useEffect(() => {
    if (!id || !version) {
      return;
    }
    void load();
  }, [id, version]);

  /** 下载原文件：手动 fetch 带 Authorization（window.open 丢 header → 401） */
  async function handleDownload() {
    if (!data) {
      return;
    }
    setActionError('');
    setLoadingFile(true);
    try {
      const res = await fetch(`/api/projects/${id}/blueprints/versions/${version}/file`, {
        headers: { Authorization: `Bearer ${getAccessToken()}` },
      });
      if (!res.ok) {
        throw new Error(`下载失败（${res.status}）`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.drawio?.name ?? `blueprint-v${data.version}.drawio`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '下载失败');
    } finally {
      setLoadingFile(false);
    }
  }

  /** 页面内预览：draw.io 文件本质 XML 文本，只读展示 */
  async function handlePreview() {
    if (!data || preview !== null) {
      return;
    }
    setActionError('');
    setLoadingFile(true);
    try {
      const res = await fetch(`/api/projects/${id}/blueprints/versions/${version}/file`, {
        headers: { Authorization: `Bearer ${getAccessToken()}` },
      });
      if (!res.ok) {
        throw new Error(`读取文件失败（${res.status}）`);
      }
      setPreview(await res.text());
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '读取文件失败');
    } finally {
      setLoadingFile(false);
    }
  }

  if (error) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <p style={{ color: '#b91c1c' }}>{error}</p>
        <Link href={`/projects/${id}/blueprints`}>← 返回蓝图</Link>
      </div>
    );
  }
  if (!data) {
    return <p style={{ textAlign: 'center', color: '#6b7280' }}>加载中…</p>;
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <p>
        <Link href={`/projects/${id}/blueprints`}>← 返回蓝图</Link>
      </p>
      <h2>蓝图 v{data.version}</h2>
      <p style={{ color: '#6b7280', marginTop: -8 }}>
        发布于 {new Date(data.publishedAt).toLocaleString('zh-CN')} · 发布人：
        {data.publishedBy?.displayName ?? '（已删除）'}
      </p>

      <dl style={{ display: 'grid', gap: 10, marginTop: 12 }}>
        {FIELD_KEYS.map(([key, label]) => (
          <div key={key}>
            <dt style={{ color: '#6b7280', margin: 0 }}>{label}</dt>
            <dd style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap' }}>
              {data[key] || '（未填写）'}
            </dd>
          </div>
        ))}
      </dl>

      <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
        <span style={{ color: '#6b7280', fontSize: 13 }}>
          流程图：{data.drawio?.name ?? '（无）'}（{((data.drawio?.size ?? 0) / 1024).toFixed(1)} KB）
        </span>
        <button type="button" onClick={handleDownload} disabled={loadingFile}>
          {loadingFile ? '处理中…' : '下载原文件'}
        </button>
        <button type="button" onClick={handlePreview} disabled={loadingFile || preview !== null}>
          {preview !== null ? '已加载预览' : '预览'}
        </button>
      </div>
      {actionError && <p style={{ color: '#b91c1c' }}>{actionError}</p>}

      {preview !== null && (
        <pre
          style={{
            marginTop: 12,
            padding: 12,
            maxHeight: 400,
            overflow: 'auto',
            background: '#f9fafb',
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {preview}
        </pre>
      )}
    </div>
  );
}
