'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  IssueCreateResponseSchema,
  IssuesListResponseSchema,
  type IssuesListResponse,
} from '@monitor/contracts';
import type {
  IssueCategory,
  IssuePriority,
  IssueStatus,
  IssueType,
} from '@monitor/shared';
import { apiFetch, errorMessage } from '../../../../lib/api';
import {
  ISSUE_CATEGORY_LABELS,
  ISSUE_PRIORITY_LABELS,
  ISSUE_STATUS_LABELS,
  ISSUE_TYPE_LABELS,
} from '../../../../lib/issue-labels';

const EMPTY_FILTERS = { type: '', category: '', priority: '', status: '', reporterId: '' };
const EMPTY_FORM = { title: '', description: '', type: 'bug', category: 'function', priority: 'medium' };

/**
 * 问题清单（issue #15 验收 ④ + issue #20 前端）：
 * - 所有项目成员 + 内部可见（后端 403 非成员）
 * - 筛选（类型/分类/优先级/状态/提交人）+ 标题搜索（300ms 防抖，同客户页模式）
 *   ——提交人下拉选项 = 当前列表数据去重（Phase 1 量小，无成员名单端点）
 * - 提交问题：viewerRole 非 null（即项目成员）均可提交（spec §2.4 提交=全员）
 */
export default function IssuesPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<IssuesListResponse | null>(null);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);

  const viewerRole = data?.viewerRole ?? null;
  const canCreate = viewerRole !== null; // 项目成员（含内部）均可提交

  async function load(override?: Partial<typeof filters> & { search?: string }) {
    const merged = { ...filters, search, ...override };
    const params = new URLSearchParams();
    (Object.keys(merged) as (keyof typeof merged)[]).forEach((k) => {
      if (merged[k]) {
        params.set(k, merged[k]);
      }
    });
    const qs = params.toString();
    try {
      const res = await apiFetch(`/api/projects/${id}/issues${qs ? `?${qs}` : ''}`, {
        schema: IssuesListResponseSchema,
      });
      setData(res);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useEffect(() => {
    if (!id) {
      return;
    }
    void load({});
  }, [id]);

  // 筛选变化即时刷新；搜索 300ms 防抖（同 customers 页）
  useEffect(() => {
    if (!data) {
      return;
    }
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [filters, search]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError('');
    setCreating(true);
    try {
      await apiFetch(`/api/projects/${id}/issues`, {
        method: 'POST',
        body: {
          title: form.title,
          description: form.description.trim() || undefined,
          type: form.type,
          category: form.category,
          priority: form.priority,
        },
        schema: IssueCreateResponseSchema,
      });
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  function select(
    key: keyof typeof EMPTY_FILTERS,
    values: readonly string[],
    labels: Record<string, string>,
  ) {
    return (
      <select
        value={filters[key]}
        onChange={(e) => setFilters({ ...filters, [key]: e.target.value })}
      >
        <option value="">全部{key === 'type' ? '类型' : key === 'category' ? '分类' : key === 'priority' ? '优先级' : '状态'}</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {labels[v]}
          </option>
        ))}
      </select>
    );
  }

  /** 提交人下拉：当前列表数据去重（reporterId + reporterName；filter 后非 null 需断言窄化） */
  const reporters = Array.from(
    new Map(
      (data?.issues ?? [])
        .filter((i) => i.reporterId !== null && i.reporterName)
        .map((i) => [i.reporterId as string, i.reporterName] as const),
    ).entries(),
  );

  if (error) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <p style={{ color: '#b91c1c' }}>{error}</p>
        <Link href={`/projects/${id}`}>← 返回项目详情</Link>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <p>
        <Link href={`/projects/${id}`}>← 返回项目详情</Link>
      </p>
      <h2>问题清单</h2>

      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          padding: 12,
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          marginBottom: 12,
        }}
      >
        {select('type', ['bug', 'feature', 'question'] as const, ISSUE_TYPE_LABELS)}
        {select('category', ['function', 'data', 'usage', 'technical', 'optimization'] as const, ISSUE_CATEGORY_LABELS)}
        {select('priority', ['high', 'medium', 'low'] as const, ISSUE_PRIORITY_LABELS)}
        {select('status', ['new', 'in_progress', 'resolved', 'closed'] as const, ISSUE_STATUS_LABELS)}
        <select
          value={filters.reporterId}
          onChange={(e) => setFilters({ ...filters, reporterId: e.target.value })}
        >
          <option value="">全部提交人</option>
          {reporters.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <input
          placeholder="搜索标题…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 160 }}
        />
      </div>

      {canCreate && (
        <form
          onSubmit={handleCreate}
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            padding: 12,
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            marginBottom: 16,
            background: '#f9fafb',
          }}
        >
          <input
            placeholder="问题标题"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            style={{ flex: 1, minWidth: 200 }}
          />
          <select
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value as IssueType })}
          >
            {Object.entries(ISSUE_TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <select
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value as IssueCategory })}
          >
            {Object.entries(ISSUE_CATEGORY_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <select
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: e.target.value as IssuePriority })}
          >
            {Object.entries(ISSUE_PRIORITY_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <input
            placeholder="描述（可选）"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            style={{ flex: 1, minWidth: 200 }}
          />
          <button type="submit" disabled={creating || !form.title}>
            {creating ? '提交中…' : '提交问题'}
          </button>
        </form>
      )}
      {createError && <p style={{ color: '#b91c1c' }}>{createError}</p>}

      {data && (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {data.issues.map((issue) => (
            <li key={issue.id}>
              <Link
                href={`/projects/${id}/issues/${issue.id}`}
                style={{ textDecoration: 'none', color: 'inherit' }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '10px 14px',
                    border: '1px solid #e5e7eb',
                    borderRadius: 8,
                  }}
                >
                  <span>
                    <strong>{issue.title}</strong>
                    {issue.description && (
                      <span style={{ color: '#6b7280', marginLeft: 8 }}>{issue.description}</span>
                    )}
                  </span>
                  <span style={{ display: 'flex', gap: 8, alignItems: 'center', whiteSpace: 'nowrap' }}>
                    <span style={{ color: '#6b7280', fontSize: 13 }}>
                      {ISSUE_TYPE_LABELS[issue.type]} · {ISSUE_CATEGORY_LABELS[issue.category]} ·{' '}
                      优先级{ISSUE_PRIORITY_LABELS[issue.priority]} · 提交人：
                      {issue.reporterName ?? '（已删除）'}
                    </span>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: 999,
                        fontSize: 12,
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
                      }}
                    >
                      {ISSUE_STATUS_LABELS[issue.status]}
                    </span>
                  </span>
                </div>
              </Link>
            </li>
          ))}
          {data.issues.length === 0 && (
            <li style={{ color: '#6b7280' }}>暂无问题{search || filters.type || filters.category || filters.priority || filters.status || filters.reporterId ? '（试试调整筛选）' : '，提交第一个问题吧'}</li>
          )}
        </ul>
      )}
    </div>
  );
}
