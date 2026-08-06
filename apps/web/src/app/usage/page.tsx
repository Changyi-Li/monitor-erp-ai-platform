'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  UsageSummaryResponseSchema,
  UsageTrendResponseSchema,
  USAGE_SCENES,
  type UsageGroupEntry,
  type UsageSummaryResponse,
  type UsageTrendResponse,
} from '@monitor/contracts';
import { apiFetch, errorMessage } from '../../lib/api';

/**
 * AI 用量统计页（issue #23 验收④ demo path）：
 * - 筛选器：时间段（今天/近 7 天/近 30 天/全部）+ 场景 + 模型 → summary/trend 即时重载
 * - 汇总卡片：总调用次数 / 输入 tokens / 输出 tokens / 预估成本（fake 阶段 — 预留）
 * - 四维分组表：按客户/项目/场景/模型汇总（未归属组显示「未归属」）
 * - 趋势图：纯 CSS 柱条（零依赖，按最大值归一高度，hover 显示数值）
 * 内部专属（agent:use 权限域）；客户用户访问后端 403 兜底。
 */

const SCENE_LABELS: Record<string, string> = {
  agent: '客服问答',
  document_parsing: '文档解析',
  manual_generation: '手册生成',
  embedding: 'Embedding',
};

const RANGE_OPTIONS = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
] as const;

type RangeValue = (typeof RANGE_OPTIONS)[number]['value'];

/** 时间段 → from ISO（全部时间不传 from） */
function rangeFromIso(range: RangeValue): string | null {
  const now = new Date();
  if (range === 'today') now.setHours(0, 0, 0, 0);
  if (range === '7d') now.setDate(now.getDate() - 7);
  if (range === '30d') now.setDate(now.getDate() - 30);
  return range === 'all' ? null : now.toISOString();
}

function formatTokens(n: number): string {
  return n.toLocaleString('zh-CN');
}

/** 分组表（客户/项目/场景/模型各一块） */
function GroupTable({ title, rows }: { title: string; rows: UsageGroupEntry[] }) {
  return (
    <section style={{ marginTop: 16 }}>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p style={{ color: '#9ca3af' }}>暂无数据</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ color: '#6b7280', fontSize: 12, textAlign: 'left' }}>
              <th style={{ padding: '6px 8px' }}>名称</th>
              <th style={{ padding: '6px 8px' }}>调用次数</th>
              <th style={{ padding: '6px 8px' }}>输入 tokens</th>
              <th style={{ padding: '6px 8px' }}>输出 tokens</th>
              <th style={{ padding: '6px 8px' }}>成本（预留）</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key ?? `unassigned-${title}`} style={{ borderTop: '1px solid #e5e7eb' }}>
                <td style={{ padding: '6px 8px' }}>{r.name}</td>
                <td style={{ padding: '6px 8px' }}>{r.calls}</td>
                <td style={{ padding: '6px 8px' }}>{formatTokens(r.inputTokens)}</td>
                <td style={{ padding: '6px 8px' }}>{formatTokens(r.outputTokens)}</td>
                <td style={{ padding: '6px 8px' }}>{r.costUsd === null ? '—' : `$${r.costUsd}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** 趋势柱状图（纯 CSS flex 柱条，零图表库依赖） */
function TrendChart({ points }: { points: UsageTrendResponse['points'] }) {
  const max = useMemo(
    () => Math.max(1, ...points.map((p) => Math.max(p.inputTokens, p.outputTokens))),
    [points],
  );
  if (points.length === 0) {
    return <p style={{ color: '#9ca3af' }}>暂无趋势数据——去 AI 客服提问后这里会出现柱条</p>;
  }
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 140, marginTop: 8 }}>
      {points.map((p) => (
        <div key={p.bucket} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end' }}>
          <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', flex: 1, width: '100%' }}>
            <div
              title={`${new Date(p.bucket).toLocaleDateString('zh-CN')} 输入 ${formatTokens(p.inputTokens)} tokens`}
              style={{ flex: 1, background: '#93c5fd', borderRadius: '4px 4px 0 0', minHeight: 2, height: `${Math.max(2, (p.inputTokens / max) * 100)}%` }}
            />
            <div
              title={`${new Date(p.bucket).toLocaleDateString('zh-CN')} 输出 ${formatTokens(p.outputTokens)} tokens`}
              style={{ flex: 1, background: '#2563eb', borderRadius: '4px 4px 0 0', minHeight: 2, height: `${Math.max(2, (p.outputTokens / max) * 100)}%` }}
            />
          </div>
          <span style={{ fontSize: 11, color: '#6b7280' }}>
            {new Date(p.bucket).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function UsagePage() {
  const [summary, setSummary] = useState<UsageSummaryResponse | null>(null);
  const [trend, setTrend] = useState<UsageTrendResponse | null>(null);
  const [range, setRange] = useState<RangeValue>('all');
  const [scene, setScene] = useState('all');
  const [model, setModel] = useState('all');
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const qs = new URLSearchParams();
        const from = rangeFromIso(range);
        if (from) qs.set('from', from);
        if (scene !== 'all') qs.set('scene', scene);
        if (model !== 'all') qs.set('model', model);
        const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
        const [s, t] = await Promise.all([
          apiFetch(`/api/usage/summary${suffix}`, { schema: UsageSummaryResponseSchema }),
          apiFetch(`/api/usage/trend${suffix}`, { schema: UsageTrendResponseSchema }),
        ]);
        setSummary(s);
        setTrend(t);
        setError('');
      } catch (err) {
        setError(errorMessage(err));
      }
    }
    void load();
  }, [range, scene, model]);

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <p>
        <Link href="/">← 返回首页</Link>
      </p>
      <h2>AI 用量统计</h2>
      <p style={{ color: '#6b7280', fontSize: 13 }}>
        所有 LLM 调用统一经 LLMClient 计量落库（issue #23）；内部专属视图——客户账号无法访问。
        成本为预留字段（真实模型接入后按 token 单价估算；客户 AI 成本视图 = Token 成本 + RAG Index 规格费）。
      </p>

      {/* 筛选器 */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
        <label style={{ fontSize: 13, color: '#6b7280' }}>
          时间段：
          <select value={range} onChange={(e) => setRange(e.target.value as RangeValue)} style={{ marginLeft: 4 }}>
            {RANGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 13, color: '#6b7280' }}>
          场景：
          <select value={scene} onChange={(e) => setScene(e.target.value)} style={{ marginLeft: 4 }}>
            <option value="all">全部</option>
            {USAGE_SCENES.map((s) => (
              <option key={s} value={s}>
                {SCENE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 13, color: '#6b7280' }}>
          模型：
          <select value={model} onChange={(e) => setModel(e.target.value)} style={{ marginLeft: 4 }}>
            <option value="all">全部</option>
            <option value="memory">memory</option>
          </select>
        </label>
      </div>
      {error && <p style={{ color: '#b91c1c', marginTop: 8 }}>{error}</p>}

      {/* 汇总卡片 */}
      {summary && (
        <section style={{ marginTop: 16 }}>
          <h3>总览</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            <div style={{ padding: '10px 14px', border: '1px solid #e5e7eb', borderRadius: 8 }}>
              <div style={{ fontSize: 12, color: '#6b7280' }}>调用次数</div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{summary.total.calls}</div>
            </div>
            <div style={{ padding: '10px 14px', border: '1px solid #e5e7eb', borderRadius: 8 }}>
              <div style={{ fontSize: 12, color: '#6b7280' }}>输入 tokens</div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{formatTokens(summary.total.inputTokens)}</div>
            </div>
            <div style={{ padding: '10px 14px', border: '1px solid #e5e7eb', borderRadius: 8 }}>
              <div style={{ fontSize: 12, color: '#6b7280' }}>输出 tokens</div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{formatTokens(summary.total.outputTokens)}</div>
            </div>
            <div style={{ padding: '10px 14px', border: '1px solid #e5e7eb', borderRadius: 8 }}>
              <div style={{ fontSize: 12, color: '#6b7280' }}>预估成本</div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>
                {summary.total.totalCostUsd === null ? '—' : `$${summary.total.totalCostUsd}`}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* 趋势 */}
      <section style={{ marginTop: 20 }}>
        <h3>趋势（按天）</h3>
        {trend && <TrendChart points={trend.points} />}
      </section>

      {/* 四维分组 */}
      {summary && (
        <>
          <GroupTable title="按客户" rows={summary.byCustomer} />
          <GroupTable title="按项目" rows={summary.byProject} />
          <GroupTable title="按场景" rows={summary.byScene} />
          <GroupTable title="按模型" rows={summary.byModel} />
        </>
      )}
    </div>
  );
}
