import { describe, expect, it } from 'vitest';
import {
  AssigneesListResponseSchema,
  IssueCommentCreateResponseSchema,
  IssueCommentRequestSchema,
  IssueCreateRequestSchema,
  IssueCreateResponseSchema,
  IssueGetResponseSchema,
  IssueSchema,
  IssueTransitionRequestSchema,
  IssueUpdateRequestSchema,
  IssuesListResponseSchema,
} from '../src';

const validUuid = 'b1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const validIsoDate = '2026-08-05T02:30:00.000Z';

const validIssue = {
  id: validUuid,
  projectId: validUuid,
  title: '登录页白屏',
  description: null,
  type: 'bug',
  category: 'function',
  priority: 'high',
  status: 'new',
  reporterId: validUuid,
  assigneeId: null,
  createdAt: validIsoDate,
  updatedAt: validIsoDate,
};

describe('issues 契约：IssueSchema', () => {
  it('接受合法问题对象（description/assignee 可空）', () => {
    expect(IssueSchema.safeParse(validIssue).success).toBe(true);
  });

  it('接受带描述与指派的问题对象', () => {
    expect(
      IssueSchema.safeParse({ ...validIssue, description: '详情', assigneeId: validUuid }).success,
    ).toBe(true);
  });

  it('拒绝非法枚举 / 空标题 / 非法 uuid', () => {
    expect(IssueSchema.safeParse({ ...validIssue, status: 'done' }).success).toBe(false);
    expect(IssueSchema.safeParse({ ...validIssue, category: 'other' }).success).toBe(false);
    expect(IssueSchema.safeParse({ ...validIssue, type: 'other' }).success).toBe(false);
    expect(IssueSchema.safeParse({ ...validIssue, priority: 'urgent' }).success).toBe(false);
    expect(IssueSchema.safeParse({ ...validIssue, title: '  ' }).success).toBe(false);
    expect(IssueSchema.safeParse({ ...validIssue, id: 'x' }).success).toBe(false);
  });
});

describe('issues 契约：列表与详情', () => {
  it('列表响应为 { issues, viewerRole }', () => {
    expect(
      IssuesListResponseSchema.safeParse({ issues: [validIssue], viewerRole: 'internal' }).success,
    ).toBe(true);
    expect(
      IssuesListResponseSchema.safeParse({ issues: [], viewerRole: null }).success,
    ).toBe(true);
    expect(IssuesListResponseSchema.safeParse({ issues: [{}] }).success).toBe(false);
  });

  it('详情响应为 { issue, viewerRole, comments }', () => {
    const comment = {
      id: validUuid,
      issueId: validUuid,
      authorId: validUuid,
      authorName: '张三',
      content: '复现步骤：…',
      createdAt: validIsoDate,
    };
    expect(
      IssueGetResponseSchema.safeParse({
        issue: validIssue,
        viewerRole: 'project_manager',
        comments: [comment],
      }).success,
    ).toBe(true);
    expect(IssueGetResponseSchema.safeParse({ issue: validIssue }).success).toBe(false);
  });
});

describe('issues 契约：提交', () => {
  it('接受合法提交请求（type/category/priority 三枚举）', () => {
    expect(
      IssueCreateRequestSchema.safeParse({
        title: '表格导出乱码',
        description: '导出后打开是乱码',
        type: 'bug',
        category: 'data',
        priority: 'medium',
      }).success,
    ).toBe(true);
  });

  it('拒绝空标题 / 非法枚举', () => {
    expect(
      IssueCreateRequestSchema.safeParse({ title: '  ', type: 'bug', category: 'function', priority: 'low' }).success,
    ).toBe(false);
    expect(
      IssueCreateRequestSchema.safeParse({ title: 'x', type: 'bug', category: 'other', priority: 'low' }).success,
    ).toBe(false);
  });

  it('提交响应为 { issue }', () => {
    expect(IssueCreateResponseSchema.safeParse({ issue: validIssue }).success).toBe(true);
  });
});

describe('issues 契约：修改/流转/评论', () => {
  it('接受部分更新（含 assigneeId null 取消指派）', () => {
    expect(IssueUpdateRequestSchema.safeParse({ title: '改标题' }).success).toBe(true);
    expect(IssueUpdateRequestSchema.safeParse({ assigneeId: validUuid }).success).toBe(true);
    expect(IssueUpdateRequestSchema.safeParse({ assigneeId: null }).success).toBe(true);
    expect(IssueUpdateRequestSchema.safeParse({}).success).toBe(true);
    expect(IssueUpdateRequestSchema.safeParse({ assigneeId: 'x' }).success).toBe(false);
  });

  it('流转请求只接受合法状态枚举', () => {
    expect(IssueTransitionRequestSchema.safeParse({ status: 'in_progress' }).success).toBe(true);
    expect(IssueTransitionRequestSchema.safeParse({ status: 'done' }).success).toBe(false);
  });

  it('评论请求 trim 后非空、限长', () => {
    expect(IssueCommentRequestSchema.safeParse({ content: '补充信息' }).success).toBe(true);
    expect(IssueCommentRequestSchema.safeParse({ content: '   ' }).success).toBe(false);
    expect(IssueCommentRequestSchema.safeParse({ content: 'x'.repeat(2001) }).success).toBe(false);
    expect(IssueCommentCreateResponseSchema.safeParse({ comment: {} }).success).toBe(false);
  });

  it('指派候选响应为 { assignees }', () => {
    expect(
      AssigneesListResponseSchema.safeParse({
        assignees: [{ id: validUuid, displayName: '张三' }],
      }).success,
    ).toBe(true);
  });
});
