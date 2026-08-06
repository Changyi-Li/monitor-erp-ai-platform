'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  StageResponseSchema,
  StageTemplatesResponseSchema,
  StagesListResponseSchema,
  type Stage,
  type StageTemplate,
} from '@monitor/contracts';
import { apiFetch, errorMessage } from '../../../../lib/api';
import {
  STAGE_STATUS_LABELS,
  STAGE_STATUS_ORDER,
} from '../../../../lib/stage-labels';

/**
 * 实施阶段看板（issue #17 验收 ④ 前端）：
 * - 泳道视图：未开始 / 进行中 / 已完成 / 已暂停 四列，列内按 sortOrder 排序
 * - 内部（实施）：从标准模板建阶段、编辑、状态流转（select 直接切换）、
 *   上移/下移排序、删除
 * - 客户用户：只读看板（无操作入口；后端 403 兜底）
 */
export default function StagesPage() {
  const { id } = useParams<{ id: string }>();
  const [stages, setStages] = useState<Stage[] | null>(null);
  const [templates, setTemplates] = useState<StageTemplate[]>([]);
  const [viewerRole, setViewerRole] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  // 创建表单
  const [form, setForm] = useState({ templateKey: '', name: '', description: '' });
  // 编辑中的阶段 id + 草稿
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', description: '' });

  const canManage = viewerRole === 'internal'; // spec §2.4 line 81：阶段维护仅内部

  async function load() {
    try {
      const res = await apiFetch(`/api/projects/${id}/stages`, {
        schema: StagesListResponseSchema,
      });
      setStages(res.stages);
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
    apiFetch(`/api/projects/${id}/stages/templates`, {
      schema: StageTemplatesResponseSchema,
    })
      .then((t) => setTemplates(t.templates))
      .catch(() => undefined); // 模板只影响创建表单，失败不阻塞看板
  }, [id]);

  /** 从模板建阶段（选中模板自动填充名称/描述，可改） */
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setActionError('');
    setSaving(true);
    try {
      await apiFetch(`/api/projects/${id}/stages`, {
        method: 'POST',
        body: {
          ...(form.templateKey ? { templateKey: form.templateKey } : {}),
          name: form.name,
          description: form.description || undefined,
        },
        schema: StageResponseSchema,
      });
      setForm({ templateKey: '', name: '', description: '' });
      setCreating(false);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function pickTemplate(key: string) {
    const tpl = templates.find((t) => t.key === key);
    setForm({
      templateKey: key,
      name: tpl?.name ?? '',
      description: tpl?.description ?? '',
    });
  }

  /** 状态流转（自由四态：select 直接切换） */
  async function handleStatus(stageId: string, status: string) {
    setActionError('');
    try {
      await apiFetch(`/api/projects/${id}/stages/${stageId}`, {
        method: 'PATCH',
        body: { status },
        schema: StageResponseSchema,
      });
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  /** 保存编辑（名称/描述） */
  async function handleSaveEdit(stageId: string) {
    setActionError('');
    setSaving(true);
    try {
      await apiFetch(`/api/projects/${id}/stages/${stageId}`, {
        method: 'PATCH',
        body: { name: draft.name, description: draft.description || null },
        schema: StageResponseSchema,
      });
      setEditingId(null);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(stageId: string, name: string) {
    if (!window.confirm(`删除阶段「${name}」？关联该阶段的风险会保留但解除关联。`)) {
      return;
    }
    setActionError('');
    try {
      await apiFetch<void>(`/api/projects/${id}/stages/${stageId}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  /** 上移/下移（全量重排后 PUT reorder） */
  async function handleMove(stageId: string, dir: -1 | 1) {
    if (!stages) {
      return;
    }
    const idx = stages.findIndex((s) => s.id === stageId);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= stages.length) {
      return;
    }
    const next = [...stages];
    const [moved] = next.splice(idx, 1);
    next.splice(target, 0, moved);
    setActionError('');
    try {
      const res = await apiFetch(`/api/projects/${id}/stages/reorder`, {
        method: 'PUT',
        body: { stageIds: next.map((s) => s.id) },
        schema: StagesListResponseSchema,
      });
      setStages(res.stages);
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
  if (!stages) {
    return <p style={{ textAlign: 'center', color: '#6b7280' }}>加载中…</p>;
  }

  return (
    <div style={{ maxWidth: 980, margin: '0 auto' }}>
      <p>
        <Link href={`/projects/${id}`}>← 返回项目详情</Link>
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2>实施阶段</h2>
        {canManage && !creating && (
          <button type="button" onClick={() => setCreating(true)}>
            新建阶段
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
            <label style={{ color: '#6b7280', fontSize: 13 }}>标准模板（可选）：</label>
            <select
              value={form.templateKey}
              onChange={(e) => pickTemplate(e.target.value)}
              style={{ marginLeft: 8 }}
            >
              <option value="">自定义（不使用模板）</option>
              {templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name} — {t.description}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ color: '#6b7280', fontSize: 13 }}>阶段名称：</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              style={{ marginLeft: 8, minWidth: 260 }}
              placeholder="必填"
            />
          </div>
          <div>
            <label style={{ color: '#6b7280', fontSize: 13 }}>描述：</label>
            <input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              style={{ marginLeft: 8, minWidth: 260 }}
            />
          </div>
          <div>
            <button type="submit" disabled={saving || !form.name.trim()}>
              {saving ? '创建中…' : '创建阶段'}
            </button>
          </div>
        </form>
      )}

      {stages.length === 0 ? (
        <p style={{ color: '#6b7280' }}>该项目还没有实施阶段，{canManage ? '点击「新建阶段」开始' : '请等待内部用户创建'}。</p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 12,
            marginTop: 8,
          }}
        >
          {STAGE_STATUS_ORDER.map((status) => {
            const columnStages = stages.filter((s) => s.status === status);
            return (
              <section
                key={status}
                style={{
                  border: '1px solid #e5e7eb',
                  borderRadius: 8,
                  padding: 8,
                  minHeight: 200,
                  background: status === 'completed' ? '#f0fdf4' : '#f9fafb',
                }}
              >
                <h3 style={{ margin: '4px 8px 8px', fontSize: 14 }}>
                  {STAGE_STATUS_LABELS[status]}（{columnStages.length}）
                </h3>
                <div style={{ display: 'grid', gap: 8 }}>
                  {columnStages.map((s) => (
                    <div
                      key={s.id}
                      style={{
                        padding: 10,
                        border: '1px solid #e5e7eb',
                        borderRadius: 8,
                        background: '#fff',
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>{s.name}</div>
                      {s.description && (
                        <div style={{ color: '#6b7280', fontSize: 13, marginBottom: 6 }}>
                          {s.description}
                        </div>
                      )}
                      {s.templateKey && (
                        <div style={{ color: '#9ca3af', fontSize: 12, marginBottom: 6 }}>
                          模板：{templates.find((t) => t.key === s.templateKey)?.name ?? s.templateKey}
                        </div>
                      )}
                      {canManage && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                          <select
                            value={s.status}
                            onChange={(e) => void handleStatus(s.id, e.target.value)}
                            style={{ fontSize: 12 }}
                            title="切换状态"
                          >
                            {STAGE_STATUS_ORDER.map((st) => (
                              <option key={st} value={st}>
                                {STAGE_STATUS_LABELS[st]}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            style={{ fontSize: 12 }}
                            onClick={() => {
                              setEditingId(editingId === s.id ? null : s.id);
                              setDraft({ name: s.name, description: s.description ?? '' });
                            }}
                          >
                            {editingId === s.id ? '取消' : '编辑'}
                          </button>
                          <button
                            type="button"
                            style={{ fontSize: 12 }}
                            disabled={s === stages[0]}
                            onClick={() => void handleMove(s.id, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            style={{ fontSize: 12 }}
                            disabled={s === stages[stages.length - 1]}
                            onClick={() => void handleMove(s.id, 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            style={{ fontSize: 12, color: '#b91c1c' }}
                            onClick={() => void handleDelete(s.id, s.name)}
                          >
                            删除
                          </button>
                        </div>
                      )}
                      {canManage && editingId === s.id && (
                        <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                          <input
                            value={draft.name}
                            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                            placeholder="阶段名称"
                          />
                          <input
                            value={draft.description}
                            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                            placeholder="描述"
                          />
                          <button
                            type="button"
                            disabled={saving || !draft.name.trim()}
                            onClick={() => void handleSaveEdit(s.id)}
                          >
                            {saving ? '保存中…' : '保存'}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {columnStages.length === 0 && (
                    <p style={{ color: '#9ca3af', fontSize: 13, textAlign: 'center', margin: 8 }}>
                      无
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
