import { describe, expect, it } from 'vitest';
import {
  BlueprintCreateRequestSchema,
  BlueprintGetResponseSchema,
  BlueprintPublishResponseSchema,
  BlueprintSchema,
  BlueprintUpdateRequestSchema,
  BlueprintVersionGetResponseSchema,
  BlueprintVersionSchema,
  BlueprintVersionsListResponseSchema,
} from '../src';

const validUuid = 'b1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const validIsoDate = '2026-08-05T02:30:00.000Z';

const validDrawio = { id: validUuid, name: '蓝图.drawio', contentType: 'application/xml', size: 1234 };
const validBlueprint = {
  id: validUuid,
  projectId: validUuid,
  businessRequirements: '业务需求',
  moduleScope: null,
  configNotes: null,
  processDescription: null,
  drawio: validDrawio,
  latestVersion: 1,
  createdAt: validIsoDate,
  updatedAt: validIsoDate,
};
const validVersion = {
  id: validUuid,
  blueprintId: validUuid,
  version: 2,
  businessRequirements: '业务需求 v2',
  moduleScope: null,
  configNotes: null,
  processDescription: null,
  drawio: validDrawio,
  publishedBy: { id: validUuid, displayName: '实施顾问' },
  publishedAt: validIsoDate,
};

describe('blueprints 契约：BlueprintSchema', () => {
  it('接受合法蓝图对象（未上传文件时 drawio 可为 null）', () => {
    expect(BlueprintSchema.safeParse(validBlueprint).success).toBe(true);
    expect(
      BlueprintSchema.safeParse({ ...validBlueprint, drawio: null, latestVersion: null }).success,
    ).toBe(true);
  });

  it('拒绝非法 uuid / 超长字段 / 非法版本号', () => {
    expect(BlueprintSchema.safeParse({ ...validBlueprint, id: 'x' }).success).toBe(false);
    expect(
      BlueprintSchema.safeParse({ ...validBlueprint, businessRequirements: 'a'.repeat(20001) })
        .success,
    ).toBe(false);
    expect(BlueprintSchema.safeParse({ ...validBlueprint, latestVersion: 0 }).success).toBe(false);
  });
});

describe('blueprints 契约：版本快照', () => {
  it('接受合法版本对象（发布人可空——用户删除后 set null）', () => {
    expect(BlueprintVersionSchema.safeParse(validVersion).success).toBe(true);
    expect(BlueprintVersionSchema.safeParse({ ...validVersion, publishedBy: null }).success).toBe(
      true,
    );
  });

  it('拒绝非正版本号', () => {
    expect(BlueprintVersionSchema.safeParse({ ...validVersion, version: 0 }).success).toBe(false);
  });
});

describe('blueprints 契约：请求', () => {
  const validUpload = { name: '流程.drawio', contentType: 'application/xml', base64: 'bXlmaWxl' };

  it('创建请求：drawio 必填（首版必带文件），结构字段可选', () => {
    expect(
      BlueprintCreateRequestSchema.safeParse({
        businessRequirements: '需求',
        drawio: validUpload,
      }).success,
    ).toBe(true);
    expect(BlueprintCreateRequestSchema.safeParse({ drawio: validUpload }).success).toBe(true);
    expect(BlueprintCreateRequestSchema.safeParse({}).success).toBe(false); // 缺 drawio
  });

  it('更新请求：drawio 可选（不带则保留现有文件）', () => {
    expect(BlueprintUpdateRequestSchema.safeParse({ businessRequirements: '改' }).success).toBe(
      true,
    );
    expect(BlueprintUpdateRequestSchema.safeParse({}).success).toBe(true); // 空对象 = 无操作
  });

  it('拒绝超限 base64 / 空文件名 / 超长结构字段', () => {
    expect(
      BlueprintCreateRequestSchema.safeParse({ drawio: { ...validUpload, base64: '' } }).success,
    ).toBe(false);
    expect(
      BlueprintCreateRequestSchema.safeParse({
        drawio: { ...validUpload, base64: 'a'.repeat(8_000_001) },
      }).success,
    ).toBe(false);
    expect(
      BlueprintCreateRequestSchema.safeParse({ drawio: { ...validUpload, name: '  ' } }).success,
    ).toBe(false);
    expect(
      BlueprintCreateRequestSchema.safeParse({
        drawio: validUpload,
        configNotes: 'a'.repeat(20001),
      }).success,
    ).toBe(false);
  });
});

describe('blueprints 契约：响应', () => {
  it('详情为 { blueprint, viewerRole }（viewerRole 同 projects 模式；未创建时 blueprint 可为 null）', () => {
    expect(
      BlueprintGetResponseSchema.safeParse({ blueprint: validBlueprint, viewerRole: 'internal' })
        .success,
    ).toBe(true);
    expect(
      BlueprintGetResponseSchema.safeParse({ blueprint: null, viewerRole: 'internal' }).success,
    ).toBe(true);
    expect(
      BlueprintGetResponseSchema.safeParse({ blueprint: validBlueprint, viewerRole: 'project_manager' })
        .success,
    ).toBe(true);
    expect(
      BlueprintGetResponseSchema.safeParse({ blueprint: validBlueprint, viewerRole: 'other' })
        .success,
    ).toBe(false);
  });

  it('创建/发布响应为 { blueprint, version }', () => {
    expect(
      BlueprintPublishResponseSchema.safeParse({ blueprint: validBlueprint, version: validVersion })
        .success,
    ).toBe(true);
  });

  it('版本列表为 { versions: [] }，版本详情为 { version }', () => {
    expect(BlueprintVersionsListResponseSchema.safeParse({ versions: [validVersion] }).success).toBe(
      true,
    );
    expect(BlueprintVersionGetResponseSchema.safeParse({ version: validVersion }).success).toBe(
      true,
    );
  });
});
