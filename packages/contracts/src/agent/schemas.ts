import { z } from 'zod';

/**
 * 内部客服 AI Agent（issue #22，spec §5）：
 * LangGraph.js 图（检索/生成/引用解析）+ 会话 checkpoint 数据库持久化（多轮记忆、回看/继续）
 * + 引用溯源（回答带 [n] 角标 → 点击跳转知识库原文）+ 检索范围后端注入（内部 KB + 所有客户 Index，仅内部用户）。
 */

/** 引用条目（回答中 [n] 角标 → 文档跳转；前端按 documentType 构造 URL） */
export const AgentCitationSchema = z.object({
  index: z.number().int().positive(),
  documentId: z.uuid(),
  title: z.string(),
  documentType: z.enum(['kb_document', 'blueprint']),
  /** blueprint → 项目蓝图列表页需要 projectId；kb 文档为 null */
  projectId: z.uuid().nullable().optional(),
});
export type AgentCitation = z.output<typeof AgentCitationSchema>;

/** 消息（会话回看/继续）；user 行 citations 恒为空数组 */
export const AgentMessageSchema = z.object({
  id: z.uuid(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  citations: z.array(AgentCitationSchema),
  createdAt: z.iso.datetime(),
});
export type AgentMessage = z.output<typeof AgentMessageSchema>;

/** 会话（列表/新建/继续） */
export const AgentConversationSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AgentConversation = z.output<typeof AgentConversationSchema>;

export const AgentConversationsResponseSchema = z.object({
  conversations: z.array(AgentConversationSchema),
});
export type AgentConversationsResponse = z.output<typeof AgentConversationsResponseSchema>;

export const AgentMessagesResponseSchema = z.object({ messages: z.array(AgentMessageSchema) });
export type AgentMessagesResponse = z.output<typeof AgentMessagesResponseSchema>;

/** 提问请求（POST /agent/conversations/:id/messages） */
export const AgentSendRequestSchema = z.object({
  content: z.string().trim().min(1, { error: '消息不能为空' }).max(4000),
});
export type AgentSendRequest = z.output<typeof AgentSendRequestSchema>;

/**
 * SSE 事件线协议（POST messages 响应，无 zod 校验，前端 streamChat 解析）：
 * Content-Type: text/event-stream; charset=utf-8
 *
 *   event: citations
 *   data: {"citations":[{"index":1,"documentId":"…","title":"…","documentType":"kb_document","projectId":null}]}
 *
 *   event: token
 *   data: {"delta":"回答文本增量"}
 *
 *   event: done
 *   data: {"message":{AgentMessage 完整消息（含 citations）}}
 *
 * 事件顺序：citations（先于回答，供前端预渲染引用区）→ token*（增量拼接为回答）→ done。
 * 错误：SSE 开始前（事务内）出错 → 正常 JSON 4xx/5xx；流开始后无 DB 错误面。
 */
