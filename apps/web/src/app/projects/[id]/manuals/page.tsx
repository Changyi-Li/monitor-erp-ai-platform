'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  ManualGenerationsListResponseSchema,
  ProjectGetResponseSchema,
  type ManualGeneration,
  type ProjectGetResponse,
} from '@monitor/contracts';
import { apiFetch, errorMessage } from '../../../../lib/api';

/** 生成会话状态标签 */
const STATUS_LABELS: Record<ManualGeneration['status'], string> = {
  in_progress: '生成中',
  published: '已落知识库',
};

/**
 * 操作手册生成会话列表（issue #26 验收 ①③ 前端）：
 * - 查看 = 项目成员（客户用户可见列表，无新建入口；后端 403 兜底）
 * - 新建手册（internal）→ 向导 Step1 选蓝图版本
 * - stale 徽标 = 蓝图已发布更新版本（读时计算，AC4）——建议重新生成，不覆盖已审校内容
 * - kb 链接 = 已发布落库的 kb 草稿（用户继续走 kb 发布端点进客户 Index）
 */
export default function ManualsPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<ProjectGetResponse | null>(null);
  const [generations, setGenerations] = useState<ManualGeneration[] | null>(null);
  const [error, setError] = useState('');

  const canManage = project?.viewerRole === 'internal'; // spec §2.4：手册维护仅内部

  useEffect(() => {
    if (!id) {
      return;
    }
    apiFetch(`/api/projects/${id}`, { schema: ProjectGetResponseSchema })
      .then(setProject)
      .catch((err: unknown) => setError(errorMessage(err)));
    apiFetch(`/api/projects/${id}/manuals`, {
      schema: ManualGenerationsListResponseSchema,
    })
      .then((res) => setGenerations(res.generations))
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [id]);

  if (error) {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <p style={{ color: '#b91c1c' }}>{error}</p>
        <Link href={`/projects/${id}`}>← 返回项目详情</Link>
      </div>
    );
  }
  if (!project || !generations) {
    return <p style={{ textAlign: 'center', color: '#6b7280' }}>加载中…</p>;
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <p>
        <Link href={`/projects/${id}`}>← 返回项目详情</Link>
      </p>
      <h2>操作手册</h2>
      <p style={{ color: '#6b7280', marginTop: -8 }}>
        基于蓝图流程 + 客户数据，由 AI 分章节生成、逐章审校后组装成册，发布进客户知识库。
      </p>

      {canManage && (
        <p style={{ marginTop: 12 }}>
          <Link
            href={`/projects/${id}/manuals/new`}
            style={{
              display: 'inline-block',
              padding: '8px 16px',
              background: '#2563eb',
              color: '#fff',
              borderRadius: 8,
              textDecoration: 'none',
            }}
          >
            + 新建手册
          </Link>
        </p>
      )}

      <section style={{ marginTop: 16 }}>
        {generations.length === 0 && (
          <p style={{ color: '#6b7280' }}>
            尚无生成会话。{canManage ? '点击「新建手册」选择蓝图版本开始。' : ''}
          </p>
        )}
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {generations.map((g) => (
            <li
              key={g.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 12px',
                border: '1px solid #e5e7eb',
                borderRadius: 8,
              }}
            >
              <Link
                href={`/projects/${id}/manuals/${g.id}`}
                style={{ flex: 1, textDecoration: 'none', color: 'inherit' }}
              >
                <strong>{g.title}</strong>
                <span style={{ color: '#6b7280', marginLeft: 8, fontSize: 13 }}>
                  蓝图 v{g.blueprintVersion} · {STATUS_LABELS[g.status]} · 章节进度{' '}
                  {g.readyCount}/{g.chapterCount} ·{' '}
                  {new Date(g.createdAt).toLocaleString('zh-CN')} · 创建人：
                  {g.createdBy?.displayName ?? '（已删除）'}
                </span>
              </Link>
              {g.stale && (
                <span
                  title="蓝图已发布更新版本；重新生成会创建新会话新草稿，不会覆盖已审校内容"
                  style={{
                    padding: '2px 8px',
                    background: '#fef3c7',
                    color: '#92400e',
                    borderRadius: 999,
                    fontSize: 12,
                    whiteSpace: 'nowrap',
                  }}
                >
                  蓝图已发布 v{g.currentBlueprintVersion}，建议重新生成
                </span>
              )}
              {g.kbDocumentId && (
                <Link
                  href={`/kb/${g.kbDocumentId}`}
                  style={{ fontSize: 13, color: '#2563eb', whiteSpace: 'nowrap' }}
                >
                  知识库草稿 →
                </Link>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
