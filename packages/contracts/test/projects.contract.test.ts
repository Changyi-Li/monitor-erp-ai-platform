import { describe, expect, it } from 'vitest';
import {
  ProjectCreateRequestSchema,
  ProjectCreateResponseSchema,
  ProjectGetResponseSchema,
  ProjectSchema,
  ProjectsListResponseSchema,
  type Project,
} from '../src';

const validUuid = 'b1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const validIsoDate = '2026-08-05T02:30:00.000Z';

const validProject = {
  id: validUuid,
  name: '实施一期',
  tenantId: 'a1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  createdAt: validIsoDate,
  updatedAt: validIsoDate,
} satisfies Project;

describe('projects 契约：ProjectSchema', () => {
  it('接受合法项目（含可选 description）', () => {
    expect(ProjectSchema.safeParse(validProject).success).toBe(true);
    expect(
      ProjectSchema.safeParse({ ...validProject, description: '附注' }).success,
    ).toBe(true);
  });

  it('拒绝非法 uuid / 空名 / 超长名 / 非法日期', () => {
    expect(ProjectSchema.safeParse({ ...validProject, id: 'not-a-uuid' }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...validProject, tenantId: 'not-a-uuid' }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...validProject, name: '   ' }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...validProject, name: 'x'.repeat(129) }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...validProject, createdAt: '2026-13-99' }).success).toBe(false);
  });

  it('trim 名称；description 超长拒绝', () => {
    const result = ProjectSchema.safeParse({ ...validProject, name: '  A  ', description: 'd'.repeat(1025) });
    expect(result.success).toBe(false);
    const trimmed = ProjectSchema.safeParse({ ...validProject, name: '  A  ' });
    expect(trimmed.success).toBe(true);
    if (trimmed.success) {
      expect(trimmed.data.name).toBe('A');
    }
  });
});

describe('projects 契约：列表与详情响应', () => {
  it('列表响应为 { projects: [...] }', () => {
    expect(
      ProjectsListResponseSchema.safeParse({ projects: [validProject] }).success,
    ).toBe(true);
    expect(ProjectsListResponseSchema.safeParse({ projects: [] }).success).toBe(true);
  });

  it('详情响应为 { project, viewerRole }（viewerRole 三态：internal/项目角色/null）', () => {
    expect(ProjectGetResponseSchema.safeParse({ project: validProject, viewerRole: 'internal' }).success).toBe(true);
    expect(ProjectGetResponseSchema.safeParse({ project: validProject, viewerRole: 'customer_pm' }).success).toBe(true);
    expect(ProjectGetResponseSchema.safeParse({ project: validProject, viewerRole: null }).success).toBe(true);
    expect(ProjectGetResponseSchema.safeParse({ project: validProject }).success).toBe(false);
    expect(ProjectGetResponseSchema.safeParse({ project: validProject, viewerRole: 'admin' }).success).toBe(false);
  });

  it('详情内 project 与列表元素同构（ProjectSchema 唯一事实源）', () => {
    expect(ProjectGetResponseSchema.shape.project.safeParse(validProject).success).toBe(true);
    expect(ProjectsListResponseSchema.shape.projects.element.safeParse(validProject).success).toBe(true);
  });

  it('创建请求：tenantId 必填 + name 规则；创建响应为 { project }', () => {
    expect(ProjectCreateRequestSchema.safeParse({ tenantId: validProject.tenantId, name: '新项目' }).success).toBe(true);
    expect(ProjectCreateRequestSchema.safeParse({ name: '无租户' }).success).toBe(false);
    expect(ProjectCreateRequestSchema.safeParse({ tenantId: 'x', name: '坏租户' }).success).toBe(false);
    expect(ProjectCreateRequestSchema.safeParse({ tenantId: validProject.tenantId, name: '  ' }).success).toBe(false);
    expect(ProjectCreateResponseSchema.safeParse({ project: validProject }).success).toBe(true);
  });
});
