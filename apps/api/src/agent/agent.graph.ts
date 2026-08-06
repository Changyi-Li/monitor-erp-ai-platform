import type { AgentCitation } from '@monitor/contracts';
import {
  Annotation,
  END,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from '@langchain/langgraph';
import type { DocumentIndexPort } from '../adapters/indexing/document-index.port';
import type { LLMClient } from '../adapters/llm/llm-client.port';

/**
 * 内部客服 AI Agent 编排（issue #22，spec §5）：LangGraph.js 线性图，
 * 节点 = 检索 / 生成 / 引用解析；State 含查询、会话历史与检索结果；
 * checkpointer 数据库持久化（多轮记忆 = 同 thread_id 再 invoke 恢复 history 通道）。
 *
 * 检索范围后端注入：['internal','customer'] 全量（spec §5 内部 Agent 全量；
 * Phase 2 客户 Agent 改此处/调用处 = ['internal', tenantId]）。
 */

/** 检索命中（编号 [n] 供 prompt 角标与引用解析） */
export interface RetrievedDoc {
  index: number;
  title: string;
  content: string;
  documentId: string;
  versionNumber: number;
  documentType: 'kb_document' | 'blueprint';
  projectId?: string | null;
}

export interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

// 1.x 的 Annotation<T> 必须带 reducer（{default} 单独不算合法 SingleReducer）；
// LastValue 语义 = 恒等 reducer（覆盖最近值）
const AgentState = Annotation.Root({
  /** 本轮用户问题（invoke 输入） */
  query: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  /** 会话历史（追加 reducer，截断最近 6 条——多轮记忆的输入） */
  history: Annotation<HistoryEntry[]>({
    reducer: (left, right) => [...left, ...right].slice(-6),
    default: () => [],
  }),
  /** 检索结果（每轮覆盖） */
  retrieved: Annotation<RetrievedDoc[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  /** LLM 回答（含 [n] 角标） */
  answer: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  /** 解析后的引用（只保留回答中实际引用的编号） */
  citations: Annotation<AgentCitation[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
});

export type AgentState = typeof AgentState.State;

export interface AgentDeps {
  llm: LLMClient;
  idx: DocumentIndexPort;
  checkpointer: BaseCheckpointSaver;
}

/** 检索节点：跨 internal + customer 联合检索，按相关度编号 [1..n] 注入 prompt */
function buildRetrieveNode(idx: DocumentIndexPort) {
  return async (state: AgentState): Promise<Partial<typeof AgentState.Update>> => {
    const hits = await idx.search(state.query, ['internal', 'customer'], 5);
    return {
      retrieved: hits.map((h, i) => ({
        index: i + 1,
        title: h.document.title,
        content: h.document.content,
        documentId: h.document.documentId,
        versionNumber: h.document.versionNumber,
        documentType: h.document.documentType ?? 'kb_document',
        projectId: h.document.projectId ?? null,
      })),
    };
  };
}

/** 生成节点：组装 prompt（检索文档 + 历史 + 引用指令）→ LLMClient（memory fake 确定性） */
function buildGenerateNode(llm: LLMClient) {
  return async (state: AgentState): Promise<Partial<typeof AgentState.Update>> => {
    const docsText =
      state.retrieved
        .map((d) => `[${d.index}] 标题：${d.title}（摘要：${d.content.slice(0, 200)}）`)
        .join('\n') || '（无检索结果）';
    const historyText =
      state.history
        .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
        .join('\n') || '（无）';
    const system = [
      '你是 Monitor G5 ERP 平台的内部客服 AI Agent，请基于检索文档回答用户问题。',
      '回答必须以 [n] 角标标注来源，n 为检索文档编号；没有相关检索文档时如实说明。',
      '',
      '[检索文档]',
      docsText,
      '',
      '[历史对话]',
      historyText,
    ].join('\n');
    const { content } = await llm.chat({
      messages: [
        { role: 'system', content: system },
        ...state.history.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: state.query },
      ],
    });
    return {
      answer: content,
      history: [
        { role: 'user', content: state.query },
        { role: 'assistant', content },
      ],
    };
  };
}

/** 引用解析节点：从回答中抽 [n] → 映射检索结果 → citations（只保留被引用的） */
function buildResolveCitationsNode() {
  return async (state: AgentState): Promise<Partial<typeof AgentState.Update>> => {
    const cited = new Set<number>();
    for (const m of state.answer.matchAll(/\[(\d+)\]/g)) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n >= 1) cited.add(n);
    }
    return {
      citations: state.retrieved
        .filter((d) => cited.has(d.index))
        .map((d) => ({
          index: d.index,
          documentId: d.documentId,
          title: d.title,
          documentType: d.documentType,
          projectId: d.projectId ?? null,
        })),
    };
  };
}

/** 图工厂（纯函数，注入 LLM/Index/Checkpointer；图实例无状态——状态全在 checkpoint，并发安全） */
export function buildAgentGraph(deps: AgentDeps) {
  return new StateGraph(AgentState)
    .addNode('retrieve', buildRetrieveNode(deps.idx))
    .addNode('generate', buildGenerateNode(deps.llm))
    .addNode('resolveCitations', buildResolveCitationsNode())
    .addEdge(START, 'retrieve')
    .addEdge('retrieve', 'generate')
    .addEdge('generate', 'resolveCitations')
    .addEdge('resolveCitations', END)
    .compile({ checkpointer: deps.checkpointer });
}

/** 编译后图类型（service 注入用；CompiledStateGraph 泛型参数过多不宜手写） */
export type CompiledAgentGraph = ReturnType<typeof buildAgentGraph>;
