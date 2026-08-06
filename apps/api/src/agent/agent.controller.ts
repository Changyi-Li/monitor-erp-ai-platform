import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  AgentConversationSchema,
  AgentConversationsResponseSchema,
  AgentMessagesResponseSchema,
  AgentSendRequestSchema,
  type AgentConversationsResponse,
  type AgentMessagesResponse,
} from '@monitor/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AgentService } from './agent.service';

/**
 * 内部客服 AI Agent（issue #22，spec §5）：全局端点（无项目上下文），
 * 权限 = agent:use（仅内部；service 层按 JWT 角色断言——客户 403 兜底）。
 * POST messages = SSE 流（**不标 @ZodResponse**——ZodResponseInterceptor 会
 * safeParse handler 返回值，流式响应不走契约校验，SSE 事件线协议见 contracts）。
 */
@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  /** 新建会话（继续会话 = 同会话 id 再发消息） */
  @Post('conversations')
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse(AgentConversationSchema)
  createConversation(@CurrentUser() actor: AuthUser) {
    this.agent.assertAgentUse(actor);
    return this.agent.createConversation(actor);
  }

  /** 我的会话列表（回看/继续入口） */
  @Get('conversations')
  @ZodResponse(AgentConversationsResponseSchema)
  listConversations(
    @CurrentUser() actor: AuthUser,
  ): Promise<AgentConversationsResponse> {
    this.agent.assertAgentUse(actor);
    return this.agent.listConversations(actor);
  }

  /** 会话消息回看 */
  @Get('conversations/:id/messages')
  @ZodResponse(AgentMessagesResponseSchema)
  listMessages(
    @Param('id') id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<AgentMessagesResponse> {
    this.agent.assertAgentUse(actor);
    return this.agent.listMessages(id, actor);
  }

  /** 提问 → SSE 流（citations → token* → done；错误在流开始前为 JSON 4xx/5xx） */
  @Post('conversations/:id/messages')
  @HttpCode(HttpStatus.OK)
  async sendMessage(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AgentSendRequestSchema)) body: { content: string },
    @CurrentUser() actor: AuthUser,
    @Res({ passthrough: false }) reply: FastifyReply,
  ): Promise<void> {
    this.agent.assertAgentUse(actor);
    await this.agent.chat(id, body.content, actor, reply);
  }
}
