import { z } from 'zod';
import { CUSTOMER_ROLES } from '@monitor/shared';

/**
 * 项目（数据隔离边界）。tenantId 为所属客户 id——响应契约如实返回，
 * 隔离由服务层过滤 + 数据库 RLS 双保险，不在响应层抹除字段。
 */
export const ProjectSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(128),
  description: z.string().max(1024).nullable().optional(),
  tenantId: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Project = z.output<typeof ProjectSchema>;

export const ProjectsListResponseSchema = z.object({
  projects: z.array(ProjectSchema),
});
export type ProjectsListResponse = z.output<typeof ProjectsListResponseSchema>;

/**
 * 项目详情响应。viewerRole：当前查看者在该项目中的角色——
 * 'internal'（内部/超管全访问）、客户平台角色（customer_pm/customer_key_user/
 * customer_user）、null（无成员关系，应已被 403 拦截）。
 * 角色拆分后（T2）权限判定完全基于平台角色：project_members.role 已退役，
 * viewerRole 直接反映 users.role。前端据此显隐管理按钮（member:manage 等），
 * 免于再查成员列表。
 */
export const ProjectViewerRoleSchema = z
  .enum(['internal', ...CUSTOMER_ROLES])
  .nullable();
export type ProjectViewerRole = z.output<typeof ProjectViewerRoleSchema>;

export const ProjectGetResponseSchema = z.object({
  project: ProjectSchema,
  viewerRole: ProjectViewerRoleSchema,
});
export type ProjectGetResponse = z.output<typeof ProjectGetResponseSchema>;

/** 创建项目（super_admin/internal 专属，spec §2.1 修订：内部用户可建项目归属客户） */
export const ProjectCreateRequestSchema = z.object({
  tenantId: z.uuid({ error: '必须指定所属客户' }),
  name: z.string().trim().min(1, { error: '项目名称不能为空' }).max(128),
  description: z.string().max(1024).optional(),
});
export type ProjectCreateRequest = z.output<typeof ProjectCreateRequestSchema>;

export const ProjectCreateResponseSchema = z.object({
  project: ProjectSchema,
});
export type ProjectCreateResponse = z.output<typeof ProjectCreateResponseSchema>;
