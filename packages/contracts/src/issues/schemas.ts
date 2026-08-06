import {
  ISSUE_CATEGORIES,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  ISSUE_TYPES,
} from '@monitor/shared';
import { z } from 'zod';
import { ProjectViewerRoleSchema } from '../projects/schemas';

/**
 * 问题（issue，spec §3.5）：标题/描述/类型/分类/优先级/状态机/提交人/指派人（内部）。
 * 归属项目 = 数据隔离边界；tenantId 冗余存储供 RLS（同 projects 模式）。
 */
export const IssueSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  title: z.string().trim().min(1).max(128),
  description: z.string().nullable().optional(),
  type: z.enum(ISSUE_TYPES),
  category: z.enum(ISSUE_CATEGORIES),
  priority: z.enum(ISSUE_PRIORITIES),
  status: z.enum(ISSUE_STATUSES),
  reporterId: z.uuid().nullable(),
  assigneeId: z.uuid().nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Issue = z.output<typeof IssueSchema>;

/** 问题评论（列表内嵌在问题详情，作者名 join users） */
export const IssueCommentSchema = z.object({
  id: z.uuid(),
  issueId: z.uuid(),
  authorId: z.uuid().nullable(),
  authorName: z.string().nullable(),
  content: z.string().trim().min(1).max(2000),
  createdAt: z.iso.datetime(),
});
export type IssueComment = z.output<typeof IssueCommentSchema>;

/** 问题列表查询参数：四枚举筛选 + 标题搜索（非法枚举值 → 400） */
export const IssuesListQuerySchema = z.object({
  type: z.enum(ISSUE_TYPES).optional(),
  category: z.enum(ISSUE_CATEGORIES).optional(),
  priority: z.enum(ISSUE_PRIORITIES).optional(),
  status: z.enum(ISSUE_STATUSES).optional(),
  search: z.string().trim().max(128).optional(),
});
export type IssuesListQuery = z.output<typeof IssuesListQuerySchema>;

/** 问题列表（按项目）：viewerRole 供前端显隐提交/管理入口（同 ProjectGetResponse 模式） */
export const IssuesListResponseSchema = z.object({
  issues: z.array(IssueSchema),
  viewerRole: ProjectViewerRoleSchema,
});
export type IssuesListResponse = z.output<typeof IssuesListResponseSchema>;

export const IssueGetResponseSchema = z.object({
  issue: IssueSchema,
  viewerRole: ProjectViewerRoleSchema,
  comments: z.array(IssueCommentSchema),
});
export type IssueGetResponse = z.output<typeof IssueGetResponseSchema>;

/** 提交问题（spec 36：所有项目角色 + 内部；reporterId 由服务层取当前用户，不暴露） */
export const IssueCreateRequestSchema = z.object({
  title: z.string().trim().min(1, { error: '问题标题不能为空' }).max(128),
  description: z.string().max(4000).optional(),
  type: z.enum(ISSUE_TYPES, { error: '类型必须是 缺陷/需求/咨询' }),
  category: z.enum(ISSUE_CATEGORIES, { error: '分类必须是 功能/数据/使用/技术/优化' }),
  priority: z.enum(ISSUE_PRIORITIES, { error: '优先级必须是 高/中/低' }),
});
export type IssueCreateRequest = z.output<typeof IssueCreateRequestSchema>;

/** 修改/管理（spec 38：PM+；部分更新，undefined 不动、null 清空，空对象=无操作） */
export const IssueUpdateRequestSchema = z.object({
  title: z.string().trim().min(1, { error: '问题标题不能为空' }).max(128).optional(),
  description: z.string().max(4000).nullable().optional(),
  type: z.enum(ISSUE_TYPES).optional(),
  category: z.enum(ISSUE_CATEGORIES).optional(),
  priority: z.enum(ISSUE_PRIORITIES).optional(),
  assigneeId: z.uuid({ error: '指派人必须是内部用户' }).nullable().optional(),
});
export type IssueUpdateRequest = z.output<typeof IssueUpdateRequestSchema>;

/** 状态流转（spec 37：内部专属；严格线性前进，非法流转 400） */
export const IssueTransitionRequestSchema = z.object({
  status: z.enum(ISSUE_STATUSES, { error: '目标状态非法' }),
});
export type IssueTransitionRequest = z.output<typeof IssueTransitionRequestSchema>;

/** 评论（spec 39/40：PM/KeyUser/内部；普通用户 403） */
export const IssueCommentRequestSchema = z.object({
  content: z.string().trim().min(1, { error: '评论内容不能为空' }).max(2000),
});
export type IssueCommentRequest = z.output<typeof IssueCommentRequestSchema>;

export const IssueCreateResponseSchema = z.object({ issue: IssueSchema });
export type IssueCreateResponse = z.output<typeof IssueCreateResponseSchema>;

export const IssueUpdateResponseSchema = z.object({ issue: IssueSchema });
export type IssueUpdateResponse = z.output<typeof IssueUpdateResponseSchema>;

export const IssueTransitionResponseSchema = z.object({ issue: IssueSchema });
export type IssueTransitionResponse = z.output<typeof IssueTransitionResponseSchema>;

export const IssueCommentCreateResponseSchema = z.object({ comment: IssueCommentSchema });
export type IssueCommentCreateResponse = z.output<typeof IssueCommentCreateResponseSchema>;

/** 指派候选（内部/超管 active 用户，PM 指派用） */
export const AssigneesListResponseSchema = z.object({
  assignees: z.array(z.object({ id: z.uuid(), displayName: z.string() })),
});
export type AssigneesListResponse = z.output<typeof AssigneesListResponseSchema>;
