import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  type AgentConversation,
  type AgentConversationsResponse,
  type AgentCitation,
  type AgentMessagesResponse,
} from '@monitor/contracts';
import { can, type FunctionalRole } from '@monitor/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import { AUDIT_ACTIONS, AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/current-user.decorator';
import { DRIZZLE, type Database } from '../database/database.module';
import {
  aiConversations,
  aiMessages,
  type AiConversationRow,
  type AiMessageRow,
} from '../database/schema';
import { AGENT_GRAPH } from './agent.constants';
import type { CompiledAgentGraph } from './agent.graph';

/**
 * 内部客服 AI Agent 编排（issue #22，spec §5）。
 *
 * chat = SSE 主流程（「算完回放」式流式）：
 * 1. 断言 agent:use + 会话归属（userId=actor.sub，无 → 404）
 * 2. graph.invoke —— **请求事务内**：checkpointer 写 + ai_messages（user/assistant）
 *    双写同事务原子；首轮 title 快照
 * 3. 审计 agent.chat
 * 4. reply.hijack() 写 SSE（citations → token 分块 → done），事务在 handler 返回时提交
 * 5. hijack 前抛错 = 正常 4xx/5xx + 请求事务回滚；hijack 后无 DB 操作，无 mid-stream 错误面
 */
@Injectable()
export class AgentService {
  constructor(
    @Inject(AGENT_GRAPH) private readonly graph: CompiledAgentGraph,
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** agent:use = 仅内部（spec §5 权限行；无项目上下文，直接按 JWT 角色） */
  assertAgentUse(actor: AuthUser): void {
    if (!can(actor.role as FunctionalRole, 'agent:use')) {
      throw new ForbiddenException('仅内部用户可使用 AI 客服');
    }
  }

  /** 新建会话（首条消息前 title 为默认值「新会话」） */
  async createConversation(actor: AuthUser): Promise<AgentConversation> {
    const [row] = await this.db
      .insert(aiConversations)
      .values({ userId: actor.sub })
      .returning();
    const conversation = row!;
    await this.audit.record(AUDIT_ACTIONS.AGENT_CONVERSATION_CREATE, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'ai_conversation',
      resourceId: conversation.id,
    });
    return toConversationDto(conversation);
  }

  /** 我的会话列表（内部用户互不可见：应用层 userId 过滤） */
  async listConversations(actor: AuthUser): Promise<AgentConversationsResponse> {
    const rows = await this.db
      .select()
      .from(aiConversations)
      .where(eq(aiConversations.userId, actor.sub))
      .orderBy(desc(aiConversations.updatedAt))
      .limit(100);
    return { conversations: rows.map(toConversationDto) };
  }

  /** 会话消息回看（继续会话 = 同 thread_id 再提问，checkpointer 恢复多轮记忆） */
  async listMessages(conversationId: string, actor: AuthUser): Promise<AgentMessagesResponse> {
    await this.requireOwnedConversation(conversationId, actor);
    const rows = await this.db
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.conversationId, conversationId))
      .orderBy(asc(aiMessages.createdAt))
      .limit(200);
    return { messages: rows.map(toMessageDto) };
  }

  /** SSE 主流程（时序见类注释） */
  async chat(
    conversationId: string,
    content: string,
    actor: AuthUser,
    reply: FastifyReply,
  ): Promise<void> {
    const conv = await this.requireOwnedConversation(conversationId, actor);

    const final = await this.graph.invoke(
      { query: content },
      { configurable: { thread_id: conversationId } }, // PregelOptions extends RunnableConfig
    );
    const answer = final.answer as string;
    const citations = (final.citations ?? []) as AgentCitation[];
    const now = new Date();

    // 消息投影 + 会话时间戳（与 checkpointer 同请求事务，原子）
    await this.db.insert(aiMessages).values({
      conversationId,
      role: 'user',
      content,
      citations: null,
    });
    const [assistantRow] = await this.db
      .insert(aiMessages)
      .values({ conversationId, role: 'assistant', content: answer, citations })
      .returning();
    const assistant = assistantRow!;
    await this.db
      .update(aiConversations)
      .set({
        title: conv.title === '新会话' ? content.slice(0, 20) : conv.title,
        updatedAt: now,
      })
      .where(eq(aiConversations.id, conversationId));

    await this.audit.record(AUDIT_ACTIONS.AGENT_CHAT, {
      actorUserId: actor.sub,
      actorRole: actor.role,
      resourceType: 'ai_conversation',
      resourceId: conversationId,
      metadata: { citationCount: citations.length },
    });

    // 事务提交后流式重放（fake 分块模拟流式；真实 token 流切片 13/14 换 LLM 流式通道，事件协议不变）
    const doneMessage = toMessageDto(assistant);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // 反代理缓冲（Next rewrites / Nginx 透传）
    });
    raw.write(`event: citations\ndata: ${JSON.stringify({ citations })}\n\n`);
    const chunks = answer.match(/.{1,6}/gs) ?? [answer];
    for (const chunk of chunks) {
      if (raw.destroyed) return; // 客户端断开即停
      raw.write(`event: token\ndata: ${JSON.stringify({ delta: chunk })}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    raw.write(`event: done\ndata: ${JSON.stringify({ message: doneMessage })}\n\n`);
    raw.end();
  }

  /** 归属校验：会话必须属于当前用户（404 防探测） */
  private async requireOwnedConversation(
    conversationId: string,
    actor: AuthUser,
  ): Promise<AiConversationRow> {
    const [row] = await this.db
      .select()
      .from(aiConversations)
      .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, actor.sub)))
      .limit(1);
    if (!row) {
      throw new NotFoundException('会话不存在');
    }
    return row;
  }
}

function toConversationDto(row: AiConversationRow): AgentConversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMessageDto(row: AiMessageRow): AgentMessagesResponse['messages'][number] {
  return {
    id: row.id,
    role: row.role as 'user' | 'assistant',
    content: row.content,
    citations: row.role === 'assistant' ? ((row.citations as AgentCitation[] | null) ?? []) : [],
    createdAt: row.createdAt.toISOString(),
  };
}
