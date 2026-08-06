import type { AgentCitation } from '@monitor/contracts';

/**
 * 内部客服 AI Agent 展示辅助（issue #22）：
 * - citationUrl：引用 → 知识库原文跳转 URL（kb 文档 / 项目蓝图列表；无 projectId 的
 *   蓝图引用退化为无链接——契约已 nullable）
 * - splitAnswerWithCitations：回答按 [n] 角标切分（web markdown 渲染器 escape-first
 *   无法插 <a>，回答以纯文本分段 + 角标渲染）
 */

export function citationUrl(c: AgentCitation): string | null {
  if (c.documentType === 'kb_document') {
    return `/kb/${c.documentId}`;
  }
  if (c.documentType === 'blueprint') {
    return c.projectId ? `/projects/${c.projectId}/blueprints` : null;
  }
  return null;
}

export interface AnswerSegment {
  text: string;
  /** 非空 = 该段是 [n] 角标（跳 citations[n-1]） */
  citationIndex: number | null;
}

/** 「根据知识库「X」：…[1]。」→ [文本, 角标(1), 文本…]；无角标 → 单段 */
export function splitAnswerWithCitations(answer: string): AnswerSegment[] {
  const parts = answer.split(/(\[(\d+)\])/g); // 交替：文本, 完整角标, 编号, 文本, …
  const segments: AnswerSegment[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) {
      if (parts[i]) segments.push({ text: parts[i] as string, citationIndex: null });
    } else if (i % 3 === 2) {
      segments.push({ text: '', citationIndex: Number(parts[i]) });
    }
  }
  return segments;
}
