import { describe, expect, it } from 'vitest';
import {
  RiskCreateRequestSchema,
  RiskResponseSchema,
  RiskSchema,
  RiskUpdateRequestSchema,
  RisksListResponseSchema,
  StageCreateRequestSchema,
  StageReorderRequestSchema,
  StageResponseSchema,
  StageSchema,
  StageTemplatesResponseSchema,
  StageUpdateRequestSchema,
  StagesListResponseSchema,
} from '../src';

const validUuid = 'b1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const validIsoDate = '2026-08-06T02:30:00.000Z';

const validStage = {
  id: validUuid,
  projectId: validUuid,
  templateKey: 'requirements',
  name: '需求分析',
  description: '调研客户业务流程',
  status: 'in_progress',
  sortOrder: 1,
  createdAt: validIsoDate,
  updatedAt: validIsoDate,
};
const validRisk = {
  id: validUuid,
  projectId: validUuid,
  stageId: validUuid,
  stageName: '需求分析',
  description: '关键数据缺失',
  level: 'high',
  status: 'open',
  ownerId: validUuid,
  ownerName: '实施顾问',
  createdAt: validIsoDate,
  updatedAt: validIsoDate,
};

describe('stages 契约：StageSchema', () => {
  it('接受合法阶段（自定义阶段 templateKey 为 null）', () => {
    expect(StageSchema.safeParse(validStage).success).toBe(true);
    expect(
      StageSchema.safeParse({ ...validStage, templateKey: null, description: null }).success,
    ).toBe(true);
  });

  it('拒绝非法状态 / 非法模板 key / 负数排序 / 超长名称', () => {
    expect(StageSchema.safeParse({ ...validStage, status: 'done' }).success).toBe(false);
    expect(StageSchema.safeParse({ ...validStage, templateKey: 'bogus' }).success).toBe(false);
    expect(StageSchema.safeParse({ ...validStage, sortOrder: -1 }).success).toBe(false);
    expect(StageSchema.safeParse({ ...validStage, name: 'a'.repeat(129) }).success).toBe(false);
  });
});

describe('stages 契约：RiskSchema', () => {
  it('接受合法风险（未关联阶段/无负责人时字段为 null）', () => {
    expect(RiskSchema.safeParse(validRisk).success).toBe(true);
    expect(
      RiskSchema.safeParse({
        ...validRisk,
        stageId: null,
        stageName: null,
        ownerId: null,
        ownerName: null,
      }).success,
    ).toBe(true);
  });

  it('拒绝非法等级 / 非法状态 / 空描述', () => {
    expect(RiskSchema.safeParse({ ...validRisk, level: 'critical' }).success).toBe(false);
    expect(RiskSchema.safeParse({ ...validRisk, status: 'done' }).success).toBe(false);
    expect(RiskSchema.safeParse({ ...validRisk, description: '  ' }).success).toBe(false);
  });
});

describe('stages 契约：请求', () => {
  it('创建阶段：name 必填，templateKey/description 可选', () => {
    expect(StageCreateRequestSchema.safeParse({ name: '系统配置' }).success).toBe(true);
    expect(
      StageCreateRequestSchema.safeParse({ templateKey: 'configuration', name: '系统配置' }).success,
    ).toBe(true);
    expect(StageCreateRequestSchema.safeParse({}).success).toBe(false);
    expect(StageCreateRequestSchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(
      StageCreateRequestSchema.safeParse({ templateKey: 'bogus', name: 'x' }).success,
    ).toBe(false);
  });

  it('更新阶段：status 自由流转（四态均可）；空对象合法', () => {
    for (const status of ['not_started', 'in_progress', 'completed', 'paused']) {
      expect(StageUpdateRequestSchema.safeParse({ status }).success).toBe(true);
    }
    expect(StageUpdateRequestSchema.safeParse({}).success).toBe(true);
    expect(StageUpdateRequestSchema.safeParse({ status: 'done' }).success).toBe(false);
  });

  it('排序调整：非空 uuid 数组；空数组拒绝', () => {
    expect(StageReorderRequestSchema.safeParse({ stageIds: [validUuid] }).success).toBe(true);
    expect(StageReorderRequestSchema.safeParse({ stageIds: [] }).success).toBe(false);
    expect(StageReorderRequestSchema.safeParse({ stageIds: ['x'] }).success).toBe(false);
  });

  it('创建风险：description/level 必填；stageId/ownerId 可空；状态默认', () => {
    expect(RiskCreateRequestSchema.safeParse({ description: '风险', level: 'high' }).success).toBe(
      true,
    );
    expect(
      RiskCreateRequestSchema.safeParse({
        description: '风险',
        level: 'low',
        stageId: null,
        ownerId: null,
      }).success,
    ).toBe(true);
    expect(RiskCreateRequestSchema.safeParse({ description: '风险' }).success).toBe(false);
    expect(RiskCreateRequestSchema.safeParse({ level: 'high' }).success).toBe(false);
    expect(RiskCreateRequestSchema.safeParse({ description: '  ', level: 'high' }).success).toBe(
      false,
    );
  });

  it('更新风险：全 optional；null 清空 stageId/ownerId', () => {
    expect(
      RiskUpdateRequestSchema.safeParse({ stageId: null, ownerId: null }).success,
    ).toBe(true);
    expect(RiskUpdateRequestSchema.safeParse({}).success).toBe(true);
  });
});

describe('stages 契约：响应', () => {
  it('模板列表为 { templates }（key 枚举合法）', () => {
    expect(
      StageTemplatesResponseSchema.safeParse({
        templates: [
          { key: 'requirements', name: '需求分析', description: '调研' },
          { key: 'go_live', name: '上线支持', description: '切换' },
        ],
      }).success,
    ).toBe(true);
    expect(
      StageTemplatesResponseSchema.safeParse({ templates: [{ key: 'bogus', name: 'x', description: '' }] })
        .success,
    ).toBe(false);
  });

  it('阶段/风险列表为 { items, viewerRole }；单条为 { stage } / { risk }', () => {
    expect(StagesListResponseSchema.safeParse({ stages: [validStage], viewerRole: 'internal' }).success).toBe(
      true,
    );
    expect(StagesListResponseSchema.safeParse({ stages: [validStage], viewerRole: 'other' }).success).toBe(
      false,
    );
    expect(StageResponseSchema.safeParse({ stage: validStage }).success).toBe(true);
    expect(RisksListResponseSchema.safeParse({ risks: [validRisk], viewerRole: 'project_manager' }).success).toBe(
      true,
    );
    expect(RiskResponseSchema.safeParse({ risk: validRisk }).success).toBe(true);
  });
});
