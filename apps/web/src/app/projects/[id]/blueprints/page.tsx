'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  BlueprintGetResponseSchema,
  BlueprintPublishResponseSchema,
  BlueprintUpdateResponseSchema,
  BlueprintVersionsListResponseSchema,
  type Blueprint,
  type BlueprintGetResponse,
  type BlueprintVersion,
} from '@monitor/contracts';
import { apiFetch, errorMessage } from '../../../../lib/api';

/** 结构化文档字段（spec §3.2：业务需求 / 模块功能范围 / 配置说明 / 流程描述） */
const FIELD_KEYS = [
  ['businessRequirements', '业务需求'],
  ['moduleScope', '模块 / 功能范围'],
  ['configNotes', '配置说明'],
  ['processDescription', '流程描述'],
] as const;

const EMPTY_FIELDS = {
  businessRequirements: '',
  moduleScope: '',
  configNotes: '',
  processDescription: '',
};

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
 * 蓝图（issue #16 验收 ④ 前端）：
 * - 内部（实施）：创建（上传 draw.io + 结构化内容 → 自动 v1）、编辑、发布新版本、
 *   版本历史列表 + 双版本对比
 * - 客户用户：只读查看（无编辑/发布入口；后端 403 兜底）
 */
export default function BlueprintsPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<BlueprintGetResponse | null>(null);
  const [versions, setVersions] = useState<BlueprintVersion[] | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [fields, setFields] = useState(EMPTY_FIELDS);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [compare, setCompare] = useState<string[]>([]); // 对比选中的版本号

  const viewerRole = data?.viewerRole ?? null;
  const blueprint: Blueprint | null = data?.blueprint ?? null;
  const canManage = viewerRole === 'internal'; // spec §2.4：蓝图维护仅内部

  async function load() {
    try {
      const res = await apiFetch(`/api/projects/${id}/blueprints`, {
        schema: BlueprintGetResponseSchema,
      });
      setData(res);
      setError('');
      const vres = await apiFetch(`/api/projects/${id}/blueprints/versions`, {
        schema: BlueprintVersionsListResponseSchema,
      });
      setVersions(vres.versions);
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

  function startEdit() {
    if (!blueprint) {
      return;
    }
    setFields({
      businessRequirements: blueprint.businessRequirements ?? '',
      moduleScope: blueprint.moduleScope ?? '',
      configNotes: blueprint.configNotes ?? '',
      processDescription: blueprint.processDescription ?? '',
    });
    setFile(null);
    setEditing(true);
  }

  /** 创建（自动发布 v1） */
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setActionError('请先选择 draw.io 流程图文件');
      return;
    }
    setActionError('');
    setSaving(true);
    try {
      const base64 = await readFileAsBase64(file);
      await apiFetch(`/api/projects/${id}/blueprints`, {
        method: 'POST',
        body: {
          ...fields,
          drawio: { name: file.name, contentType: file.type || 'application/xml', base64 },
        },
        schema: BlueprintPublishResponseSchema,
      });
      setEditing(false);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  /** 编辑当前内容（保存不生成版本；须显式发布） */
  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setActionError('');
    setSaving(true);
    try {
      const base64 = file ? await readFileAsBase64(file) : undefined;
      await apiFetch(`/api/projects/${id}/blueprints`, {
        method: 'PATCH',
        body: {
          ...fields,
          ...(file && base64
            ? { drawio: { name: file.name, contentType: file.type || 'application/xml', base64 } }
            : {}),
        },
        schema: BlueprintUpdateResponseSchema,
      });
      setEditing(false);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  /** 发布新版本（vN+1 快照） */
  async function handlePublish() {
    setActionError('');
    setSaving(true);
    try {
      await apiFetch(`/api/projects/${id}/blueprints/publish`, {
        method: 'POST',
        schema: BlueprintPublishResponseSchema,
      });
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function toggleCompare(version: number) {
    const v = String(version);
    setCompare((prev) =>
      prev.includes(v) ? prev.filter((x) => x !== v) : prev.length >= 2 ? prev : [...prev, v],
    );
  }

  const compareVersions = useMemo(() => {
    if (compare.length !== 2 || !versions) {
      return null;
    }
    const [a, b] = compare.map((v) => versions.find((x) => x.version === Number(v))).filter(Boolean);
    return a && b ? [a, b] : null;
  }, [compare, versions]);

  if (error) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <p style={{ color: '#b91c1c' }}>{error}</p>
        <Link href={`/projects/${id}`}>← 返回项目详情</Link>
      </div>
    );
  }
  if (!data) {
    return <p style={{ textAlign: 'center', color: '#6b7280' }}>加载中…</p>;
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <p>
        <Link href={`/projects/${id}`}>← 返回项目详情</Link>
      </p>
      <h2>蓝图</h2>
      {!blueprint && (
        <p style={{ color: '#6b7280' }}>该项目尚未创建蓝图。</p>
      )}
      {actionError && <p style={{ color: '#b91c1c' }}>{actionError}</p>}

      {canManage && !editing && (
        <div style={{ display: 'flex', gap: 8, margin: '8px 0 16px' }}>
          {blueprint && (
            <>
              <button type="button" onClick={startEdit}>
                编辑内容
              </button>
              <button type="button" onClick={handlePublish} disabled={saving}>
                {saving ? '发布中…' : `发布新版本（当前 v${blueprint.latestVersion} → v${(blueprint.latestVersion ?? 0) + 1}）`}
              </button>
            </>
          )}
        </div>
      )}

      {canManage && !blueprint && !editing && (
        <button type="button" onClick={startEdit} style={{ marginBottom: 16 }}>
          创建蓝图（上传 draw.io + 填写结构化内容）
        </button>
      )}

      {editing && canManage && (
        <form
          onSubmit={blueprint ? handleSave : handleCreate}
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
          {FIELD_KEYS.map(([key, label]) => (
            <div key={key}>
              <label style={{ color: '#6b7280', fontSize: 13 }}>{label}</label>
              <textarea
                rows={key === 'processDescription' ? 4 : 3}
                value={fields[key]}
                onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ color: '#6b7280', fontSize: 13 }}>draw.io 流程图：</label>
            <input
              type="file"
              accept=".drawio,.xml"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {blueprint && !file && (
              <span style={{ color: '#6b7280', fontSize: 13 }}>
                当前：{blueprint.drawio?.name}（不选新文件则保留）
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={saving}>
              {saving ? '保存中…' : blueprint ? '保存内容' : '创建蓝图（生成 v1）'}
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </form>
      )}

      {blueprint && (
        <section style={{ padding: 12, border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 16 }}>
          <p style={{ margin: 0, color: '#6b7280' }}>
            最新版本：v{blueprint.latestVersion} · 流程图：{blueprint.drawio?.name}（
            {((blueprint.drawio?.size ?? 0) / 1024).toFixed(1)} KB）
          </p>
          {FIELD_KEYS.map(([key, label]) => (
            <div key={key} style={{ marginTop: 8 }}>
              <dt style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>{label}</dt>
              <dd style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap' }}>
                {blueprint[key] || '（未填写）'}
              </dd>
            </div>
          ))}
        </section>
      )}

      <section>
        <h3>版本历史{versions && versions.length > 0 && `（${versions.length}）`}</h3>
        {versions && versions.length > 0 && (
          <p style={{ color: '#6b7280', fontSize: 13, marginTop: 0 }}>
            勾选两个版本可对比结构化内容。
          </p>
        )}
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {versions?.map((v) => (
            <li
              key={v.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                border: '1px solid #e5e7eb',
                borderRadius: 8,
              }}
            >
              <input
                type="checkbox"
                checked={compare.includes(String(v.version))}
                disabled={!compare.includes(String(v.version)) && compare.length >= 2}
                onChange={() => toggleCompare(v.version)}
              />
              <Link href={`/projects/${id}/blueprints/versions/${v.version}`} style={{ flex: 1 }}>
                <strong>v{v.version}</strong>
                <span style={{ color: '#6b7280', marginLeft: 8, fontSize: 13 }}>
                  {new Date(v.publishedAt).toLocaleString('zh-CN')} · 发布人：
                  {v.publishedBy?.displayName ?? '（已删除）'} ·{' '}
                  {(v.businessRequirements ?? v.moduleScope ?? v.configNotes ?? v.processDescription
                    ? '有内容'
                    : '仅流程图')}
                </span>
              </Link>
            </li>
          ))}
          {versions && versions.length === 0 && (
            <li style={{ color: '#6b7280' }}>尚无版本，发布后显示在这里</li>
          )}
        </ul>

        {compareVersions && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
            {compareVersions.map((v) => (
              <div
                key={v.id}
                style={{
                  padding: 12,
                  border: '1px solid #e5e7eb',
                  borderRadius: 8,
                  background: '#f9fafb',
                }}
              >
                <h4 style={{ margin: '0 0 8px' }}>v{v.version}</h4>
                {FIELD_KEYS.map(([key, label]) => (
                  <p key={key} style={{ margin: '6px 0' }}>
                    <span style={{ color: '#6b7280', fontSize: 13 }}>{label}：</span>
                    {v[key] || '（未填写）'}
                  </p>
                ))}
                <Link href={`/projects/${id}/blueprints/versions/${v.version}`}>查看详情 →</Link>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
