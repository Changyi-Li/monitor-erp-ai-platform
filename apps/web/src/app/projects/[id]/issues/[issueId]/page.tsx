'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  AssigneesListResponseSchema,
  BlueprintGetResponseSchema,
  IssueGetResponseSchema,
  IssueLinkResponseSchema,
  IssueUpdateResponseSchema,
  KbListResponseSchema,
  MinutesListResponseSchema,
  type AssigneesListResponse,
  type IssueGetResponse,
  type IssueLink,
} from '@monitor/contracts';
import type {
  IssueCategory,
  IssueLinkTargetType,
  IssuePriority,
  IssueStatus,
  IssueType,
} from '@monitor/shared';
import { apiFetch, errorMessage } from '../../../../../lib/api';
import {
  ISSUE_CATEGORY_LABELS,
  ISSUE_LINK_TARGET_LABELS,
  ISSUE_PRIORITY_LABELS,
  ISSUE_STATUS_LABELS,
  ISSUE_TYPE_LABELS,
} from '../../../../../lib/issue-labels';

/** 严格线性状态机的下一步（issue-status.ts 同构：new→in_progress→resolved→closed） */
const NEXT_STATUS: Partial<Record<IssueStatus, IssueStatus>> = {
  new: 'in_progress',
  in_progress: 'resolved',
  resolved: 'closed',
};
const TRANSITION_BUTTONS: Partial<Record<IssueStatus, string>> = {
  new: '开始处理',
  in_progress: '标记已解决',
  resolved: '关闭问题',
};

const EMPTY_EDIT = { title: '', description: '', type: 'bug', category: 'function', priority: 'medium' };

/**
 * 问题详情（issue #15 验收 ④ + issue #20 前端）：
 * - viewerRole 驱动权限：流转=内部（spec 37）、编辑/指派/关联=PM+（spec 38）、
 *   评论=PM/KeyUser/内部（spec §2.4，普通用户只读）
 * - 评论列表内嵌（详情响应带 comments + 作者名）
 * - 关联对象区（issue #20，spec 42）：蓝图/会议纪要/知识库文档——全员可见 + 跳转链接；
 *   PM+ 可添加（目标下拉 = 复用对应列表端点）/解除
 * - 操作成功后重新拉详情刷新
 */
export default function IssueDetailPage() {
  const { id, issueId } = useParams<{ id: string; issueId: string }>();
  const [detail, setDetail] = useState<IssueGetResponse | null>(null);
  const [assignees, setAssignees] = useState<AssigneesListResponse | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [comment, setComment] = useState('');
  const [commenting, setCommenting] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState(EMPTY_EDIT);
  const [assigneeId, setAssigneeId] = useState('');
  const [saving, setSaving] = useState(false);
  // issue #20：添加关联表单（目标下拉按类型拉对应列表端点）
  const [linkType, setLinkType] = useState<IssueLinkTargetType>('blueprint');
  const [linkTargets, setLinkTargets] = useState<{ id: string; label: string }[]>([]);
  const [linkTargetId, setLinkTargetId] = useState('');
  const [addingLink, setAddingLink] = useState(false);

  const viewerRole = detail?.viewerRole ?? null;
  const issue = detail?.issue;
  // T2：issue:comment 排除 customer_user；issue:manage = internal + customer_pm（平台角色）
  const canComment = viewerRole !== null && viewerRole !== 'customer_user';
  const canManage = viewerRole === 'internal' || viewerRole === 'customer_pm';
  const canTransition = viewerRole === 'internal';
  const nextStatus = issue ? NEXT_STATUS[issue.status] : undefined;

  async function load() {
    try {
      const res = await apiFetch(`/api/projects/${id}/issues/${issueId}`, {
        schema: IssueGetResponseSchema,
      });
      setDetail(res);
      setError('');
      setActionError('');
      setComment('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useEffect(() => {
    if (!id || !issueId) {
      return;
    }
    void load();
  }, [id, issueId]);

  // 编辑/指派表单可用时拉候选（PM+；KeyUser/普通用户/外部角色请求 403 由后端挡）
  useEffect(() => {
    if (!id || !issueId || !canManage) {
      return;
    }
    apiFetch(`/api/projects/${id}/issues/assignees`, {
      schema: AssigneesListResponseSchema,
    })
      .then(setAssignees)
      .catch(() => undefined);
  }, [id, issueId, canManage]);

  function startEdit() {
    if (!issue) {
      return;
    }
    setEditForm({
      title: issue.title,
      description: issue.description ?? '',
      type: issue.type,
      category: issue.category,
      priority: issue.priority,
    });
    setAssigneeId(issue.assigneeId ?? '');
    setEditing(true);
  }

  async function handleComment(e: React.FormEvent) {
    e.preventDefault();
    setCommenting(true);
    setActionError('');
    try {
      await apiFetch(`/api/projects/${id}/issues/${issueId}/comments`, {
        method: 'POST',
        body: { content: comment },
        schema: AssigneesListResponseSchema.optional(),
      });
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setCommenting(false);
    }
  }

  async function handleTransition() {
    if (!issue || !nextStatus) {
      return;
    }
    setTransitioning(true);
    setActionError('');
    try {
      await apiFetch(`/api/projects/${id}/issues/${issueId}/transition`, {
        method: 'POST',
        body: { status: nextStatus },
        schema: AssigneesListResponseSchema.optional(),
      });
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setTransitioning(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setActionError('');
    try {
      await apiFetch(`/api/projects/${id}/issues/${issueId}`, {
        method: 'PATCH',
        body: {
          title: editForm.title,
          description: editForm.description.trim() || null,
          type: editForm.type,
          category: editForm.category,
          priority: editForm.priority,
          assigneeId: assigneeId || null,
        },
        schema: IssueUpdateResponseSchema,
      });
      setEditing(false);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  /** 关联目标下拉数据源（issue #20）：复用对应列表端点（蓝图项目唯一 → 单对象） */
  async function loadLinkTargets(type: IssueLinkTargetType) {
    try {
      if (type === 'blueprint') {
        const res = await apiFetch(`/api/projects/${id}/blueprints`, {
          schema: BlueprintGetResponseSchema,
        });
        setLinkTargets(res.blueprint ? [{ id: res.blueprint.id, label: res.blueprint.drawio?.name ?? '蓝图' }] : []);
      } else if (type === 'minute') {
        const res = await apiFetch(`/api/projects/${id}/minutes`, {
          schema: MinutesListResponseSchema,
        });
        setLinkTargets(res.minutes.map((m) => ({ id: m.id, label: m.title })));
      } else {
        const res = await apiFetch('/api/kb/documents', { schema: KbListResponseSchema });
        setLinkTargets(res.documents.map((d) => ({ id: d.id, label: d.title })));
      }
      setLinkTargetId('');
    } catch (err) {
      setLinkTargets([]);
      setActionError(errorMessage(err));
    }
  }

  /** 添加关联（PM+，issue:manage） */
  async function handleAddLink(e: React.FormEvent) {
    e.preventDefault();
    if (!linkTargetId) {
      return;
    }
    setAddingLink(true);
    setActionError('');
    try {
      await apiFetch(`/api/projects/${id}/issues/${issueId}/links`, {
        method: 'POST',
        body: { targetType: linkType, targetId: linkTargetId },
        schema: IssueLinkResponseSchema,
      });
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setAddingLink(false);
    }
  }

  /** 解除关联（PM+，issue:manage） */
  async function handleRemoveLink(l: IssueLink) {
    if (!window.confirm(`解除与「${l.targetTitle ?? '该对象'}」的关联？`)) {
      return;
    }
    setActionError('');
    try {
      await apiFetch(`/api/projects/${id}/issues/${issueId}/links/${l.id}`, {
        method: 'DELETE',
      });
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  /** 关联对象跳转链接（蓝图项目唯一；纪要/知识库 → 详情页） */
  function linkHref(l: IssueLink): string {
    if (l.targetType === 'blueprint') {
      return `/projects/${id}/blueprints`;
    }
    if (l.targetType === 'minute') {
      return `/projects/${id}/minutes/${l.targetId}`;
    }
    return `/kb/${l.targetId}`;
  }

  if (error) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <p style={{ color: '#b91c1c' }}>{error}</p>
        <Link href={`/projects/${id}/issues`}>← 返回问题清单</Link>
      </div>
    );
  }
  if (!detail || !issue) {
    return <p style={{ textAlign: 'center', color: '#6b7280' }}>加载中…</p>;
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <p>
        <Link href={`/projects/${id}/issues`}>← 返回问题清单</Link>
      </p>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h2 style={{ marginBottom: 0 }}>{issue.title}</h2>
        <span
          style={{
            padding: '4px 12px',
            borderRadius: 999,
            fontSize: 13,
            background:
              issue.status === 'closed'
                ? '#e5e7eb'
                : issue.status === 'resolved'
                  ? '#f0fdf4'
                  : issue.status === 'in_progress'
                    ? '#eff6ff'
                    : '#fef3c7',
            color:
              issue.status === 'closed'
                ? '#6b7280'
                : issue.status === 'resolved'
                  ? '#15803d'
                  : issue.status === 'in_progress'
                    ? '#1d4ed8'
                    : '#92400e',
            whiteSpace: 'nowrap',
          }}
        >
          {ISSUE_STATUS_LABELS[issue.status]}
        </span>
      </div>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', marginTop: 12 }}>
        <dt style={{ color: '#6b7280' }}>类型</dt>
        <dd style={{ margin: 0 }}>{ISSUE_TYPE_LABELS[issue.type]}</dd>
        <dt style={{ color: '#6b7280' }}>分类</dt>
        <dd style={{ margin: 0 }}>{ISSUE_CATEGORY_LABELS[issue.category]}</dd>
        <dt style={{ color: '#6b7280' }}>优先级</dt>
        <dd style={{ margin: 0 }}>{ISSUE_PRIORITY_LABELS[issue.priority]}</dd>
        <dt style={{ color: '#6b7280' }}>提交人</dt>
        <dd style={{ margin: 0 }}>{issue.reporterName ?? '（已删除）'}</dd>
        <dt style={{ color: '#6b7280' }}>负责人</dt>
        <dd style={{ margin: 0 }}>
          {issue.assigneeId
            ? assignees?.assignees.find((a) => a.id === issue.assigneeId)?.displayName ?? '内部用户'
            : '未指派'}
        </dd>
        {issue.description && (
          <>
            <dt style={{ color: '#6b7280' }}>描述</dt>
            <dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{issue.description}</dd>
          </>
        )}
      </dl>

      {actionError && <p style={{ color: '#b91c1c' }}>{actionError}</p>}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        {canTransition && nextStatus && (
          <button type="button" onClick={handleTransition} disabled={transitioning}>
            {transitioning ? '流转中…' : TRANSITION_BUTTONS[issue.status]}
          </button>
        )}
        {canManage && !editing && (
          <button type="button" onClick={startEdit}>
            编辑 / 指派
          </button>
        )}
      </div>

      {editing && canManage && (
        <form
          onSubmit={handleSave}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            marginTop: 16,
            padding: 12,
            border: '1px solid #e5e7eb',
            borderRadius: 8,
          }}
        >
          <input
            placeholder="标题"
            value={editForm.title}
            onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
          />
          <textarea
            placeholder="描述（留空清除）"
            value={editForm.description}
            onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
            rows={3}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <select
              value={editForm.type}
              onChange={(e) => setEditForm({ ...editForm, type: e.target.value as IssueType })}
            >
              {Object.entries(ISSUE_TYPE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <select
              value={editForm.category}
              onChange={(e) => setEditForm({ ...editForm, category: e.target.value as IssueCategory })}
            >
              {Object.entries(ISSUE_CATEGORY_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <select
              value={editForm.priority}
              onChange={(e) => setEditForm({ ...editForm, priority: e.target.value as IssuePriority })}
            >
              {Object.entries(ISSUE_PRIORITY_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ color: '#6b7280' }}>指派内部负责人：</label>
            <select
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              style={{ flex: 1 }}
            >
              <option value="">未指派</option>
              {assignees?.assignees.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={saving || !editForm.title}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </form>
      )}

      <section style={{ marginTop: 24 }}>
        <h3>关联对象</h3>
        {detail.links.length === 0 ? (
          <p style={{ color: '#6b7280' }}>暂无关联</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
            {detail.links.map((l) => (
              <li
                key={l.id}
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
                    padding: '1px 8px',
                    borderRadius: 999,
                    background: '#f3f4f6',
                    color: '#374151',
                  }}
                >
                  {ISSUE_LINK_TARGET_LABELS[l.targetType]}
                </span>
                {l.targetTitle ? (
                  <Link href={linkHref(l)} style={{ color: '#2563eb' }}>
                    {l.targetTitle}
                  </Link>
                ) : (
                  <span style={{ color: '#9ca3af' }}>（不可见）</span>
                )}
                <span style={{ color: '#6b7280', fontSize: 13, marginLeft: 'auto' }}>
                  关联人：{l.createdBy?.displayName ?? '—'}
                </span>
                {canManage && (
                  <button type="button" onClick={() => void handleRemoveLink(l)}>
                    解除
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <form
            onSubmit={handleAddLink}
            style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}
          >
            <select
              value={linkType}
              onChange={(e) => {
                const t = e.target.value as IssueLinkTargetType;
                setLinkType(t);
                void loadLinkTargets(t);
              }}
            >
              {Object.entries(ISSUE_LINK_TARGET_LABELS).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
            <select
              value={linkTargetId}
              onChange={(e) => setLinkTargetId(e.target.value)}
              style={{ flex: 1, minWidth: 160 }}
            >
              <option value="">选择{ISSUE_LINK_TARGET_LABELS[linkType]}…</option>
              {linkTargets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <button type="submit" disabled={addingLink || !linkTargetId}>
              {addingLink ? '关联中…' : '关联'}
            </button>
          </form>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h3>评论</h3>
        {canComment && (
          <form
            onSubmit={handleComment}
            style={{ display: 'flex', gap: 8, marginBottom: 12 }}
          >
            <input
              placeholder="补充信息、讨论解决方案…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="submit" disabled={commenting || !comment.trim()}>
              {commenting ? '发表中…' : '评论'}
            </button>
          </form>
        )}
        {detail.comments.length === 0 && (
          <p style={{ color: '#6b7280' }}>暂无评论</p>
        )}
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {detail.comments.map((c) => (
            <li
              key={c.id}
              style={{
                padding: '8px 12px',
                border: '1px solid #e5e7eb',
                borderRadius: 8,
              }}
            >
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{c.content}</p>
              <p style={{ margin: '6px 0 0', color: '#6b7280', fontSize: 13 }}>
                {c.authorName ?? '（已删除）'} · {new Date(c.createdAt).toLocaleString('zh-CN')}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
