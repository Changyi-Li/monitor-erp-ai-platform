import { z } from 'zod';

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

export const ProjectGetResponseSchema = z.object({
  project: ProjectSchema,
});
export type ProjectGetResponse = z.output<typeof ProjectGetResponseSchema>;
