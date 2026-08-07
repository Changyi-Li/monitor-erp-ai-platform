'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  ManualAssembleResponseSchema,
  ManualChapterResponseSchema,
  ManualGenerationDetailResponseSchema,
  type ManualChapter,
  type ManualGenerationDetailResponse,
} from '@monitor/contracts';
import { apiFetch, errorMessage } from '../lib/api';
import { renderMarkdownSafe } from '../lib/markdown';

/** 章节状态色（进度/审校列表） */
const CHAPTER_STATUS_COLORS: Record<ManualChapter['status'], string> = {
  pending: '#6b7280',
  ready: '#2563eb',
  edited: '#15803d',
};
const CHAPTER_STATUS_LABELS: Record<ManualChapter['status'], string> = {
  pending: '待生成',
  ready: 'AI 已生成',
  edited: '已审校',
};

/**
 * 操作手册生成向导（issue #26 验收 ②③④ 前端，Step2-5；Step1 选版本在 new 页）：
 * - Step2 章节生成：状态色列表 +「全部生成」浏览器串行循环（逐章 await，进度可见，
 *   单章失败可重试）+ 单章生成/重新生成
 * - Step3 逐章审校：分栏 textarea + markdown 实时预览（escape-first 渲染器，同 kb 详情页）
 *   → 保存（PUT → edited）/ 重新生成
 * - Step4 组装预览：POST assemble → 整本渲染
 * - Step5 发布：POST publish → 落项目 kb 草稿 → 跳转 kb 详情页完成最后发布
 * - 断点续做：[generationId] 页直接挂本组件；已发布会话 → 只显示完成态 + kb 链接
 */
export function ManualWizard({
  projectId,
  generationId,
}: {
  projectId: string;
  generationId: string;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<ManualGenerationDetailResponse | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [step, setStep] = useState<'chapters' | 'review' | 'assemble' | 'published'>('chapters');
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [generating, setGenerating] = useState<string | 'all' | null>(null); // 生成中的章节 id / 'all'
  const [assembleBody, setAssembleBody] = useState<string | null>(null);
  const [assembling, setAssembling] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // 审校表单（selectedSeq 切换时填充）
  const [form, setForm] = useState<{ title: string; outline: string; contentMd: string }>({
    title: '',
    outline: '',
    contentMd: '',
  });

  const generation = detail?.generation ?? null;
  const chapters = detail?.generation.chapters ?? [];

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/projects/${projectId}/manuals/${generationId}`, {
        schema: ManualGenerationDetailResponseSchema,
      });
      setDetail(res);
      setError('');
      if (res.generation.status === 'published') {
        setStep('published');
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [projectId, generationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const readyChapters = chapters.filter((c) => c.status !== 'pending');

  /** Step2 全部生成：浏览器串行循环（逐章 await；单章失败继续下一章，稍后重试） */
  async function handleGenerateAll() {
    if (!generation) {
      return;
    }
    setActionError('');
    setGenerating('all');
    for (const chapter of chapters) {
      if (chapter.status !== 'pending') {
        continue;
      }
      await apiFetch(
        `/api/projects/${projectId}/manuals/${generationId}/chapters/${chapter.id}/generate`,
        { method: 'POST', schema: ManualChapterResponseSchema },
      ).catch(() => undefined); // 单章失败不中断全部生成
    }
    setGenerating(null);
    await load();
  }

  /** 单章生成/重新生成 */
  async function handleGenerateChapter(chapter: ManualChapter) {
    setActionError('');
    setGenerating(chapter.id);
    try {
      await apiFetch(
        `/api/projects/${projectId}/manuals/${generationId}/chapters/${chapter.id}/generate`,
        { method: 'POST', schema: ManualChapterResponseSchema },
      );
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setGenerating(null);
    }
  }

  /** Step3 选中章节 → 填充审校表单 */
  function openReview(chapter: ManualChapter) {
    setSelectedSeq(chapter.seq);
    setForm({
      title: chapter.title,
      outline: chapter.outline ?? '',
      contentMd: chapter.contentMd ?? '',
    });
    setActionError('');
  }

  /** 保存审校（PUT → status='edited'） */
  async function handleSaveReview(chapter: ManualChapter) {
    setActionError('');
    try {
      await apiFetch(
        `/api/projects/${projectId}/manuals/${generationId}/chapters/${chapter.id}`,
        {
          method: 'PUT',
          body: { title: form.title, outline: form.outline, contentMd: form.contentMd },
          schema: ManualChapterResponseSchema,
        },
      );
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  /** Step4 组装预览 */
  async function handleAssemble() {
    if (!generation) {
      return;
    }
    setActionError('');
    setAssembling(true);
    try {
      const res = await apiFetch(
        `/api/projects/${projectId}/manuals/${generationId}/assemble`,
        { method: 'POST', schema: ManualAssembleResponseSchema },
      );
      setAssembleBody(res.body);
      setStep('assemble');
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setAssembling(false);
    }
  }

  /** Step5 发布 → 落项目 kb 草稿 → 跳 kb 详情页（用户在 kb 页完成最后发布进客户 Index） */
  async function handlePublish() {
    if (!generation) {
      return;
    }
    setActionError('');
    setPublishing(true);
    try {
      const res = await apiFetch(
        `/api/projects/${projectId}/manuals/${generationId}/publish`,
        { method: 'POST', schema: ManualGenerationDetailResponseSchema },
      );
      setDetail(res);
      setStep('published');
      setPublishing(false);
      if (res.generation.kbDocumentId) {
        router.push(`/kb/${res.generation.kbDocumentId}`);
      }
    } catch (err) {
      setActionError(errorMessage(err));
      setPublishing(false);
    }
  }

  if (error) {
    return (
      <div>
        <p style={{ color: '#b91c1c' }}>{error}</p>
        <Link href={`/projects/${projectId}/manuals`}>← 返回手册列表</Link>
      </div>
    );
  }
  if (!generation) {
    return <p style={{ textAlign: 'center', color: '#6b7280' }}>加载中…</p>;
  }

  const allReady = chapters.length > 0 && readyChapters.length === chapters.length;

  return (
    <div>
      <p>
        <Link href={`/projects/${projectId}/manuals`}>← 返回手册列表</Link>
      </p>
      <h2>{generation.title}</h2>
      <p style={{ color: '#6b7280', marginTop: -8 }}>
        蓝图 v{generation.blueprintVersion} · {new Date(generation.createdAt).toLocaleString('zh-CN')}
      </p>
      {generation.stale && (
        <p
          style={{
            padding: '8px 12px',
            background: '#fef3c7',
            color: '#92400e',
            borderRadius: 8,
          }}
        >
          蓝图已发布 v{generation.currentBlueprintVersion}，建议回到列表新建会话重新生成——
          不会覆盖本会话已审校的内容。
        </p>
      )}
      {actionError && <p style={{ color: '#b91c1c' }}>{actionError}</p>}

      {step === 'published' ? (
        <section style={{ padding: 16, border: '1px solid #86efac', borderRadius: 8, background: '#f0fdf4' }}>
          <p style={{ margin: 0 }}>
            已发布为知识库草稿（分类：操作手册）。
            {generation.kbDocumentId ? (
              <>
                前往{' '}
                <Link href={`/kb/${generation.kbDocumentId}`}>知识库草稿详情</Link>
                ，在详情页执行「发布」后客户即可在知识库中查看。
              </>
            ) : (
              '（知识库文档缺失，请联系管理员）'
            )}
          </p>
        </section>
      ) : (
        <ol
          style={{
            display: 'flex',
            gap: 8,
            listStyle: 'none',
            padding: 0,
            flexWrap: 'wrap',
            margin: '12px 0',
          }}
        >
          {(
            [
              ['chapters', '章节生成', true],
              ['review', '逐章审校', readyChapters.length > 0],
              ['assemble', '组装预览', allReady],
            ] as const
          ).map(([key, label, unlocked]) => (
            <li key={key}>
              <button
                type="button"
                disabled={!unlocked}
                onClick={() => {
                  setStep(key);
                  if (key === 'review' && selectedSeq === null && readyChapters[0]) {
                    openReview(readyChapters[0]);
                  }
                }}
                style={{
                  padding: '6px 12px',
                  borderRadius: 999,
                  border: step === key ? '2px solid #2563eb' : '1px solid #e5e7eb',
                  background: step === key ? '#eff6ff' : '#fff',
                  color: unlocked ? '#111827' : '#9ca3af',
                  cursor: unlocked ? 'pointer' : 'not-allowed',
                }}
              >
                {label}
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              disabled={!allReady}
              onClick={handlePublish}
              style={{
                padding: '6px 12px',
                borderRadius: 999,
                border: '1px solid #e5e7eb',
                background: '#fff',
                color: allReady ? '#15803d' : '#9ca3af',
                cursor: allReady ? 'pointer' : 'not-allowed',
              }}
            >
              {publishing ? '发布中…' : '发布到知识库'}
            </button>
          </li>
        </ol>
      )}

      {/* Step2 章节生成 */}
      {step === 'chapters' && (
        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>章节大纲与生成（{readyChapters.length}/{chapters.length}）</h3>
            <button
              type="button"
              onClick={handleGenerateAll}
              disabled={generating !== null || readyChapters.length === chapters.length}
            >
              {generating === 'all'
                ? '生成中…'
                : readyChapters.length === chapters.length
                  ? '已全部生成'
                  : `全部生成（${chapters.length - readyChapters.length} 章待生成）`}
            </button>
          </div>
          {chapters.length === 0 && (
            <p style={{ color: '#6b7280' }}>章节大纲正在规划中…</p>
          )}
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
            {chapters.map((c) => (
              <li
                key={c.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '8px 12px',
                  border: '1px solid #e5e7eb',
                  borderRadius: 8,
                }}
              >
                <span
                  style={{
                    color: CHAPTER_STATUS_COLORS[c.status],
                    fontSize: 13,
                    width: 76,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {CHAPTER_STATUS_LABELS[c.status]}
                </span>
                <div style={{ flex: 1 }}>
                  <strong>
                    {c.seq}. {c.title}
                  </strong>
                  {c.outline && (
                    <p style={{ margin: '2px 0 0', color: '#6b7280', fontSize: 13 }}>
                      {c.outline}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleGenerateChapter(c)}
                  disabled={generating !== null}
                >
                  {generating === c.id
                    ? '生成中…'
                    : c.status === 'pending'
                      ? '生成'
                      : '重新生成'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Step3 逐章审校 */}
      {step === 'review' && (
        <section>
          <h3 style={{ marginTop: 0 }}>逐章审校</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16 }}>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }}>
              {readyChapters.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => openReview(c)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 8px',
                      borderRadius: 6,
                      border:
                        selectedSeq === c.seq ? '2px solid #2563eb' : '1px solid #e5e7eb',
                      background: selectedSeq === c.seq ? '#eff6ff' : '#fff',
                    }}
                  >
                    <span style={{ color: CHAPTER_STATUS_COLORS[c.status], fontSize: 12 }}>
                      {CHAPTER_STATUS_LABELS[c.status]}
                    </span>
                    <span style={{ display: 'block', fontSize: 13 }}>
                      {c.seq}. {c.title}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {readyChapters.map((c) => {
              if (c.seq !== selectedSeq) {
                return null;
              }
              return (
                <div
                  key={c.id}
                  style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}
                >
                  <div>
                    <label style={{ color: '#6b7280', fontSize: 13 }}>标题</label>
                    <input
                      value={form.title}
                      onChange={(e) => setForm({ ...form, title: e.target.value })}
                      style={{ width: '100%', boxSizing: 'border-box' }}
                    />
                    <label style={{ color: '#6b7280', fontSize: 13, display: 'block', marginTop: 8 }}>
                      章节大纲
                    </label>
                    <textarea
                      rows={3}
                      value={form.outline}
                      onChange={(e) => setForm({ ...form, outline: e.target.value })}
                      style={{ width: '100%', boxSizing: 'border-box' }}
                    />
                    <label style={{ color: '#6b7280', fontSize: 13, display: 'block', marginTop: 8 }}>
                      正文（Markdown）
                    </label>
                    <textarea
                      rows={16}
                      value={form.contentMd}
                      onChange={(e) => setForm({ ...form, contentMd: e.target.value })}
                      style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace' }}
                    />
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button type="button" onClick={() => handleSaveReview(c)}>
                        保存审校
                      </button>
                      <button type="button" onClick={() => handleGenerateChapter(c)}>
                        {generating === c.id ? '生成中…' : '重新生成'}
                      </button>
                    </div>
                  </div>
                  <div
                    style={{
                      padding: 12,
                      border: '1px solid #e5e7eb',
                      borderRadius: 8,
                      background: '#f9fafb',
                      overflow: 'auto',
                      maxHeight: 560,
                    }}
                  >
                    <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>预览</p>
                    <div
                      dangerouslySetInnerHTML={{
                        __html: renderMarkdownSafe(form.contentMd || '*（暂无内容）*'),
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Step4 组装预览 */}
      {step === 'assemble' && (
        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>组装预览</h3>
            <button type="button" onClick={handleAssemble} disabled={assembling}>
              {assembling ? '组装中…' : '重新组装'}
            </button>
          </div>
          {assembleBody === null && (
            <button type="button" onClick={handleAssemble} disabled={assembling}>
              {assembling ? '组装中…' : '生成整本预览'}
            </button>
          )}
          {assembleBody !== null && (
            <div
              style={{
                padding: 16,
                border: '1px solid #e5e7eb',
                borderRadius: 8,
                background: '#fff',
              }}
            >
              <div
                dangerouslySetInnerHTML={{
                  __html: renderMarkdownSafe(assembleBody),
                }}
              />
            </div>
          )}
        </section>
      )}

      {/* 底部说明 */}
      {step !== 'published' && allReady && step !== 'assemble' && (
        <p style={{ color: '#6b7280', fontSize: 13, marginTop: 16 }}>
          所有章节已就绪：可先到「组装预览」整本检查，再点击「发布到知识库」。
        </p>
      )}
    </div>
  );
}
