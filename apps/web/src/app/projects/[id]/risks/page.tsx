'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  RiskOwnersListResponseSchema,
  RiskResponseSchema,
  RisksListResponseSchema,
  StagesListResponseSchema,
  type Risk,
  type Stage,
} from '@monitor/contracts';
import { apiFetch, errorMessage } from '../../../../lib/api';
import {
  RISK_LEVEL_COLORS,
  RISK_LEVEL_LABELS,
  RISK_STATUS_LABELS,
  STAGE_STATUS_LABELS,
} from '../../../../lib/stage-labels';

const RISK_LEVELS = ['high', 'medium', 'low'] as const;
const RISK_STATUSES = ['open', 'in_progress', 'resolved'] as const;

/** 空表单初始值 */
const EMPTY_FORM = {
  description: '',
  level: 'medium',
  status: 'open',
  stageId: '',
  ownerId: '',
};

/**
 * 风险列表（issue #17 验收 ④ 前端）：
 * - 等级标色（demo path：高红/中橙/低绿）+ 状态/关联阶段/负责人展示
 * - 内部（实施）：创建、编辑（等级/状态/关联阶段/负责人）、删除
 * - 客户用户：只读列表（后端 403 兜底）
 */
export default function RisksPage() {
  const { id } = useParams<{ id: string }>();
  const [risks, setRisks] = useState<Risk[] | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [owners, setOwners] = useState<{ id: string; displayName: string }[]>([]);
  const [viewerRole, setViewerRole] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const canManage = viewerRole === 'internal'; // spec §2.4 line 81：风险管理仅内部

  async function load() {
    try {
      const res = await apiFetch(`/api/projects/${id}/risks`, {
        schema: RisksListResponseSchema,
      });
      setRisks(res.risks);
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
    // 内部表单依赖：阶段列表（关联下拉）+ 负责人候选（内部用户）
    apiFetch(`/api/projects/${id}/stages`, { schema: StagesListResponseSchema })
      .then((res) => setStages(res.stages))
      .catch(() => undefined);
    apiFetch(`/api/projects/${id}/risks/assignees`, {
      schema: RiskOwnersListResponseSchema,
    })
      .then((res) => setOwners(res.assignees))
      .catch(() => undefined);
  }, [id]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setActionError('');
    setSaving(true);
    try {
      if (editingId) {
        await apiFetch(`/api/projects/${id}/risks/${editingId}`, {
          method: 'PATCH',
          body: {
            description: form.description,
            level: form.level,
            status: form.status,
            stageId: form.stageId || null,
            ownerId: form.ownerId || null,
          },
          schema: RiskResponseSchema,
        });
      } else {
        await apiFetch(`/api/projects/${id}/risks`, {
          method: 'POST',
          body: {
            description: form.description,
            level: form.level,
            status: form.status,
            stageId: form.stageId || null,
            ownerId: form.ownerId || null,
          },
          schema: RiskResponseSchema,
        });
      }
      setEditingId(null);
      setCreating(false);
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function startEdit(risk: Risk) {
    setEditingId(risk.id);
    setForm({
      description: risk.description,
      level: risk.level,
      status: risk.status,
      stageId: risk.stageId ?? '',
      ownerId: risk.ownerId ?? '',
    });
  }

  async function handleDelete(riskId: string, description: string) {
    if (!window.confirm(`删除风险「${description.slice(0, 30)}…」？`)) {
      return;
    }
    setActionError('');
    try {
      await apiFetch<void>(`/api/projects/${id}/risks/${riskId}`, { method: 'DELETE' });
      if (editingId === riskId) {
        setEditingId(null);
        setForm(EMPTY_FORM);
      }
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
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
  if (!risks) {
    return <p style={{ textAlign: 'center', color: '#6b7280' }}>加载中…</p>;
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <p>
        <Link href={`/projects/${id}`}>← 返回项目详情</Link>
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2>风险清单</h2>
        {canManage && !creating && !editingId && (
          <button
            type="button"
            onClick={() => {
              setEditingId(null);
              setCreating(true);
              setForm(EMPTY_FORM);
            }}
          >
            新建风险
          </button>
        )}
      </div>
      {actionError && <p style={{ color: '#b91c1c' }}>{actionError}</p>}

      {canManage && creating && (
        <form
          onSubmit={handleSubmit}
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
            <label style={{ color: '#6b7280', fontSize: 13 }}>描述：</label>
            <textarea
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              style={{ width: '100%', boxSizing: 'border-box', marginTop: 4 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <label style={{ color: '#6b7280', fontSize: 13 }}>等级：</label>
              <select
                value={form.level}
                onChange={(e) => setForm({ ...form, level: e.target.value })}
              >
                {RISK_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {RISK_LEVEL_LABELS[l]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ color: '#6b7280', fontSize: 13 }}>状态：</label>
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
              >
                {RISK_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {RISK_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ color: '#6b7280', fontSize: 13 }}>关联阶段：</label>
              <select
                value={form.stageId}
                onChange={(e) => setForm({ ...form, stageId: e.target.value })}
              >
                <option value="">（不关联）</option>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}（{STAGE_STATUS_LABELS[s.status]}）
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ color: '#6b7280', fontSize: 13 }}>负责人：</label>
              <select
                value={form.ownerId}
                onChange={(e) => setForm({ ...form, ownerId: e.target.value })}
              >
                <option value="">（未指派）</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.displayName}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={saving || !form.description.trim()}>
              {saving ? '保存中…' : '创建风险'}
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setForm(EMPTY_FORM);
              }}
            >
              取消
            </button>
          </div>
        </form>
      )}

      {risks.length === 0 ? (
        <p style={{ color: '#6b7280' }}>该项目还没有风险点，{canManage ? '点击「新建风险」添加' : '请等待内部用户添加'}。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {risks.map((r) => (
            <li
              key={r.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '10px 12px',
                border: '1px solid #e5e7eb',
                borderRadius: 8,
              }}
            >
              <span
                title={`等级：${RISK_LEVEL_LABELS[r.level]}`}
                style={{
                  display: 'inline-block',
                  minWidth: 20,
                  textAlign: 'center',
                  padding: '2px 8px',
                  borderRadius: 999,
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 600,
                  background: RISK_LEVEL_COLORS[r.level] ?? '#6b7280',
                  flexShrink: 0,
                }}
              >
                {RISK_LEVEL_LABELS[r.level]}
              </span>
              <div style={{ flex: 1 }}>
                <div>{r.description}</div>
                <div style={{ color: '#6b7280', fontSize: 13, marginTop: 2 }}>
                  状态：{RISK_STATUS_LABELS[r.status]} · 关联阶段：
                  {r.stageName ?? '（无）'} · 负责人：{r.ownerName ?? '（未指派）'} ·{' '}
                  {new Date(r.updatedAt).toLocaleString('zh-CN')}
                </div>
              </div>
              {canManage && (
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button type="button" onClick={() => startEdit(r)}>
                    编辑
                  </button>
                  <button
                    type="button"
                    style={{ color: '#b91c1c' }}
                    onClick={() => void handleDelete(r.id, r.description)}
                  >
                    删除
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && editingId && (
        <form
          onSubmit={handleSubmit}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: 12,
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            marginTop: 16,
            background: '#f9fafb',
          }}
        >
          <p style={{ margin: 0, fontWeight: 600 }}>编辑风险</p>
          <div>
            <label style={{ color: '#6b7280', fontSize: 13 }}>描述：</label>
            <textarea
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              style={{ width: '100%', boxSizing: 'border-box', marginTop: 4 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <label style={{ color: '#6b7280', fontSize: 13 }}>等级：</label>
              <select
                value={form.level}
                onChange={(e) => setForm({ ...form, level: e.target.value })}
              >
                {RISK_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {RISK_LEVEL_LABELS[l]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ color: '#6b7280', fontSize: 13 }}>状态：</label>
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
              >
                {RISK_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {RISK_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ color: '#6b7280', fontSize: 13 }}>关联阶段：</label>
              <select
                value={form.stageId}
                onChange={(e) => setForm({ ...form, stageId: e.target.value })}
              >
                <option value="">（不关联）</option>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}（{STAGE_STATUS_LABELS[s.status]}）
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ color: '#6b7280', fontSize: 13 }}>负责人：</label>
              <select
                value={form.ownerId}
                onChange={(e) => setForm({ ...form, ownerId: e.target.value })}
              >
                <option value="">（未指派）</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.displayName}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={saving || !form.description.trim()}>
              {saving ? '保存中…' : '保存修改'}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setForm(EMPTY_FORM);
              }}
            >
              取消
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
