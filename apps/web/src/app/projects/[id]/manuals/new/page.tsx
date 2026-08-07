'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  BlueprintVersionsListResponseSchema,
  ManualGenerationDetailResponseSchema,
  ProjectGetResponseSchema,
  type BlueprintVersion,
  type ProjectGetResponse,
} from '@monitor/contracts';
import { apiFetch, errorMessage } from '../../../../../lib/api';
import { getAccessToken } from '../../../../../lib/token-store';

/** 结构化文档字段（选版本时参考蓝图内容，同蓝图页） */
const FIELD_KEYS = [
  ['businessRequirements', '业务需求'],
  ['moduleScope', '模块 / 功能范围'],
  ['configNotes', '配置说明'],
  ['processDescription', '流程描述'],
] as const;

/**
 * 操作手册生成向导 Step1（issue #26 验收 ② 前端）：选蓝图版本 →
 * 版本卡片（结构化字段 + drawio 原文件预览）→ 创建生成会话（自动规划章节大纲）。
 * 仅 internal（spec §2.4 手册维护仅内部；后端 403 兜底）。
 */
export default function ManualNewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<ProjectGetResponse | null>(null);
  const [versions, setVersions] = useState<BlueprintVersion[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const canManage = project?.viewerRole === 'internal';

  useEffect(() => {
    if (!id) {
      return;
    }
    apiFetch(`/api/projects/${id}`, { schema: ProjectGetResponseSchema })
      .then(setProject)
      .catch((err: unknown) => setError(errorMessage(err)));
    apiFetch(`/api/projects/${id}/blueprints/versions`, {
      schema: BlueprintVersionsListResponseSchema,
    })
      .then((res) => {
        setVersions(res.versions);
        setSelected(res.versions.length > 0 ? res.versions[0]!.version : null);
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [id]);

  const selectedVersion = versions?.find((v) => v.version === selected) ?? null;

  /** 加载选中版本的 drawio 原文件预览（fetch blob 带 Authorization，同蓝图版本页） */
  async function loadPreview(version: number) {
    setActionError('');
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/projects/${id}/blueprints/versions/${version}/file`, {
        headers: { Authorization: `Bearer ${getAccessToken()}` },
      });
      if (!res.ok) {
        throw new Error(`读取流程图失败（${res.status}）`);
      }
      setPreview(await res.text());
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '读取流程图失败');
    } finally {
      setPreviewLoading(false);
    }
  }

  /** 创建生成会话（LLM 规划章节大纲）→ 进入向导 Step2 */
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) {
      setActionError('请先选择一个蓝图版本');
      return;
    }
    setActionError('');
    setCreating(true);
    try {
      const res = await apiFetch(`/api/projects/${id}/manuals`, {
        method: 'POST',
        body: { blueprintVersion: selected, ...(title.trim() ? { title: title.trim() } : {}) },
        schema: ManualGenerationDetailResponseSchema,
      });
      router.push(`/projects/${id}/manuals/${res.generation.id}`);
    } catch (err) {
      setActionError(errorMessage(err));
      setCreating(false);
    }
  }

  if (error) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <p style={{ color: '#b91c1c' }}>{error}</p>
        <Link href={`/projects/${id}/manuals`}>← 返回手册列表</Link>
      </div>
    );
  }
  if (!project || !versions) {
    return <p style={{ textAlign: 'center', color: '#6b7280' }}>加载中…</p>;
  }
  if (!canManage) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <p style={{ color: '#b91c1c' }}>手册维护仅限内部用户。</p>
        <Link href={`/projects/${id}/manuals`}>← 返回手册列表</Link>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <p>
        <Link href={`/projects/${id}/manuals`}>← 返回手册列表</Link>
      </p>
      <h2>新建操作手册</h2>
      <p style={{ color: '#6b7280', marginTop: -8 }}>
        Step 1/5：选择蓝图版本（流程将作为手册内容来源），点击「创建」后自动规划章节大纲。
      </p>
      {actionError && <p style={{ color: '#b91c1c' }}>{actionError}</p>}

      <form onSubmit={handleCreate}>
        <label style={{ color: '#6b7280', fontSize: 13 }}>手册标题（可选）</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={`默认：${project.project.name} 操作手册 v${selected ?? ''}`}
          style={{ width: '100%', boxSizing: 'border-box', marginBottom: 12 }}
        />

        {versions.length === 0 && (
          <p style={{ color: '#6b7280' }}>
            该项目尚无蓝图版本，请先到{' '}
            <Link href={`/projects/${id}/blueprints`}>蓝图</Link> 创建。
          </p>
        )}

        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {versions.map((v) => (
            <li
              key={v.id}
              style={{
                display: 'flex',
                gap: 12,
                padding: 12,
                border: selected === v.version ? '2px solid #2563eb' : '1px solid #e5e7eb',
                borderRadius: 8,
              }}
            >
              <input
                type="radio"
                name="version"
                checked={selected === v.version}
                onChange={() => {
                  setSelected(v.version);
                  setPreview(null);
                }}
              />
              <div style={{ flex: 1 }}>
                <p style={{ margin: 0 }}>
                  <strong>v{v.version}</strong>
                  <span style={{ color: '#6b7280', marginLeft: 8, fontSize: 13 }}>
                    {new Date(v.publishedAt).toLocaleString('zh-CN')} · 发布人：
                    {v.publishedBy?.displayName ?? '（已删除）'} · 流程图：
                    {v.drawio?.name ?? '（无）'}
                  </span>
                </p>
                {FIELD_KEYS.map(([key, label]) => (
                  <p key={key} style={{ margin: '4px 0', fontSize: 13 }}>
                    <span style={{ color: '#6b7280' }}>{label}：</span>
                    {v[key] || '（未填写）'}
                  </p>
                ))}
                <button
                  type="button"
                  onClick={() => loadPreview(v.version)}
                  disabled={previewLoading || preview !== null}
                  style={{ fontSize: 13 }}
                >
                  {preview !== null ? '已加载流程预览' : previewLoading ? '加载中…' : '预览流程'}
                </button>
              </div>
            </li>
          ))}
        </ul>

        {selectedVersion && preview !== null && (
          <pre
            style={{
              marginTop: 12,
              padding: 12,
              maxHeight: 300,
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

        <p style={{ marginTop: 16 }}>
          <button
            type="submit"
            disabled={creating || versions.length === 0}
            style={{
              padding: '8px 20px',
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              cursor: creating || versions.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {creating ? '规划章节大纲中…' : '创建并规划章节大纲'}
          </button>
        </p>
      </form>
    </div>
  );
}
