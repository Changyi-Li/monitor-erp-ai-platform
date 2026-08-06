import { describe, expect, it } from 'vitest';
import {
  AgentCitationSchema,
  AgentConversationSchema,
  AgentConversationsResponseSchema,
  AgentMessageSchema,
  AgentMessagesResponseSchema,
  AgentSendRequestSchema,
} from '../src';

const validUuid = 'b1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const validIsoDate = '2026-08-06T02:30:00.000Z';

const validCitation = {
  index: 1,
  documentId: validUuid,
  title: '登录问题 FAQ',
  documentType: 'kb_document' as const,
  projectId: null,
};

const validMessage = {
  id: validUuid,
  role: 'assistant' as const,
  content: '根据知识库「登录问题 FAQ」：…更多详情见来源 [1]。',
  citations: [validCitation],
  createdAt: validIsoDate,
};

describe('agent 契约：引用', () => {
  it('接受合法 kb 引用（projectId null）', () => {
    expect(AgentCitationSchema.safeParse(validCitation).success).toBe(true);
  });

  it('接受 blueprint 引用（projectId 提供）', () => {
    expect(
      AgentCitationSchema.safeParse({
        ...validCitation,
        documentType: 'blueprint',
        projectId: validUuid,
      }).success,
    ).toBe(true);
  });

  it('拒绝非法 documentType / 缺失 documentId', () => {
    expect(
      AgentCitationSchema.safeParse({ ...validCitation, documentType: 'pdf' }).success,
    ).toBe(false);
    expect(AgentCitationSchema.safeParse({ ...validCitation, documentId: 'x' }).success).toBe(
      false,
    );
  });
});

describe('agent 契约：消息与会话', () => {
  it('接受合法 assistant 消息（citations 非空）', () => {
    expect(AgentMessageSchema.safeParse(validMessage).success).toBe(true);
  });

  it('接受 user 消息（citations 恒空数组）', () => {
    expect(
      AgentMessageSchema.safeParse({ ...validMessage, role: 'user', citations: [] }).success,
    ).toBe(true);
  });

  it('拒绝非法 role / 缺失 citations', () => {
    expect(AgentMessageSchema.safeParse({ ...validMessage, role: 'system' }).success).toBe(false);
    expect(AgentMessageSchema.safeParse({ ...validMessage, citations: undefined }).success).toBe(
      false,
    );
  });

  it('接受合法会话与响应包裹', () => {
    const conversation = {
      id: validUuid,
      title: '登录问题',
      createdAt: validIsoDate,
      updatedAt: validIsoDate,
    };
    expect(AgentConversationSchema.safeParse(conversation).success).toBe(true);
    expect(
      AgentConversationsResponseSchema.safeParse({ conversations: [conversation] }).success,
    ).toBe(true);
    expect(
      AgentMessagesResponseSchema.safeParse({ messages: [validMessage] }).success,
    ).toBe(true);
  });
});

describe('agent 契约：提问请求', () => {
  it('接受合法内容', () => {
    expect(AgentSendRequestSchema.safeParse({ content: '如何重置密码？' }).success).toBe(true);
  });

  it('拒绝空白 / 超长内容', () => {
    expect(AgentSendRequestSchema.safeParse({ content: '   ' }).success).toBe(false);
    expect(
      AgentSendRequestSchema.safeParse({ content: 'x'.repeat(4001) }).success,
    ).toBe(false);
  });
});
