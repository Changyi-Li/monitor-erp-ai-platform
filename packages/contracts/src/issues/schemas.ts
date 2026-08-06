import {
  ISSUE_CATEGORIES,
  ISSUE_LINK_TARGETS,
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
  reporterName: z.string().nullable(), // 提交人姓名（join users；删除 → null）
  assigneeId: z.uuid().nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Issue = z.output<typeof IssueSchema>;

/** 问题关联（issue #20，spec 42「关联蓝图/功能/文档」）：多态目标 + 展示用标题摘要 */
export const IssueLinkSchema = z.object({
  id: z.uuid(),
  issueId: z.uuid(),
  targetType: z.enum(ISSUE_LINK_TARGETS),
  targetId: z.uuid(),
  targetTitle: z.string().nullable(), // blueprint → drawio 文件名；minute/kb → 标题；目标不可见（RLS 挡）→ null
  createdBy: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
});
export type IssueLink = z.output<typeof IssueLinkSchema>;

/** 关联请求（spec 42：issue:manage = 内部 + PM） */
export const IssueLinkRequestSchema = z.object({
  targetType: z.enum(ISSUE_LINK_TARGETS, { error: '关联目标类型必须是 蓝图/会议纪要/知识库文档' }),
  targetId: z.uuid({ error: '关联目标 id 非法' }),
});
export type IssueLinkRequest = z.output<typeof IssueLinkRequestSchema>;

export const IssueLinkResponseSchema = z.object({ link: IssueLinkSchema });
export type IssueLinkResponse = z.output<typeof IssueLinkResponseSchema>;

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

/** 问题列表查询参数：四枚举筛选 + 提交人 + 标题搜索（非法枚举值/uuid → 400） */
export const IssuesListQuerySchema = z.object({
  type: z.enum(ISSUE_TYPES).optional(),
  category: z.enum(ISSUE_CATEGORIES).optional(),
  priority: z.enum(ISSUE_PRIORITIES).optional(),
  status: z.enum(ISSUE_STATUSES).optional(),
  reporterId: z.uuid().optional(), // spec 41「按提交人筛选」
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
  links: z.array(IssueLinkSchema), // 关联对象（全员可见；targetTitle 按 RLS 可见性）
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
