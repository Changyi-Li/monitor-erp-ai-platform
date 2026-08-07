import { describe, expect, it } from 'vitest';
import {
  ImportFetchRunResponseSchema,
  ImportPushRequestSchema,
  ImportPushResponseSchema,
  ImportStagedListResponseSchema,
  ImportStagedQuerySchema,
  ImportStagedSchema,
} from '../src';

const validUuid = 'b1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const validIsoDate = '2026-08-06T02:30:00.000Z';

const validStaged = {
  id: validUuid,
  source: 'api',
  sourceKey: 'help://guide/install',
  action: 'upsert',
  fingerprint: 'a'.repeat(64),
  title: '安装指南',
  category: 'manual',
  docType: 'markdown',
  status: 'pending',
  attempt: 0,
  duplicateCount: 0,
  createdAt: validIsoDate,
  updatedAt: validIsoDate,
};

describe('imports 契约：ImportPushRequestSchema（action + docType 判别）', () => {
  it('接受 upsert markdown 分支（sourceKey + body ≤200_000）', () => {
    expect(
      ImportPushRequestSchema.safeParse({
        action: 'upsert',
        sourceKey: 'help://guide/install',
        docType: 'markdown',
        title: '安装指南',
        category: 'manual',
        body: '# 安装\n\n1. 下载',
      }).success,
    ).toBe(true);
  });

  it('接受 upsert file 分支（base64 ≤8M 字符）', () => {
    expect(
      ImportPushRequestSchema.safeParse({
        action: 'upsert',
        sourceKey: 'help://manual/erp',
        docType: 'file',
        title: 'ERP 手册',
        category: 'manual',
        fileName: 'erp.pdf',
        contentType: 'application/pdf',
        base64: 'JVBERi0xLjQ=',
      }).success,
    ).toBe(true);
  });

  it('接受 delete 分支（只需 sourceKey）', () => {
    expect(
      ImportPushRequestSchema.safeParse({ action: 'delete', sourceKey: 'help://guide/install' })
        .success,
    ).toBe(true);
  });

  it('拒绝空 sourceKey / 非法分类 / 非法形态 / 超长 base64 / 空 body 必填', () => {
    expect(
      ImportPushRequestSchema.safeParse({
        action: 'upsert',
        sourceKey: '  ',
        docType: 'markdown',
        title: 'x',
        category: 'manual',
        body: 'b',
      }).success,
    ).toBe(false);
    expect(
      ImportPushRequestSchema.safeParse({
        action: 'upsert',
        sourceKey: 'k',
        docType: 'markdown',
        title: 'x',
        category: 'wiki',
        body: 'b',
      }).success,
    ).toBe(false);
    expect(
      ImportPushRequestSchema.safeParse({
        action: 'upsert',
        sourceKey: 'k',
        docType: 'html',
        title: 'x',
        category: 'manual',
      }).success,
    ).toBe(false);
    expect(
      ImportPushRequestSchema.safeParse({
        action: 'upsert',
        sourceKey: 'k',
        docType: 'file',
        title: 'x',
        category: 'manual',
        fileName: 'a.pdf',
        contentType: 'application/pdf',
        base64: 'a'.repeat(8_000_001),
      }).success,
    ).toBe(false);
    // markdown 分支 body 必填（外部推送必带内容；与 kb 创建「可先建框架」不同）
    expect(
      ImportPushRequestSchema.safeParse({
        action: 'upsert',
        sourceKey: 'k',
        docType: 'markdown',
        title: 'x',
        category: 'manual',
      }).success,
    ).toBe(false);
    // delete 分支缺 sourceKey 拒绝
    expect(ImportPushRequestSchema.safeParse({ action: 'delete' }).success).toBe(false);
  });
});

describe('imports 契约：ImportStagedSchema', () => {
  it('接受合法暂存行（fileName/contentType/documentId/lastError 可空）', () => {
    expect(ImportStagedSchema.safeParse(validStaged).success).toBe(true);
    expect(
      ImportStagedSchema.safeParse({
        ...validStaged,
        fileName: 'erp.pdf',
        contentType: 'application/pdf',
        documentId: validUuid,
        lastError: 'boom',
      }).success,
    ).toBe(true);
  });

  it('拒绝非法枚举 / 缺必填', () => {
    expect(ImportStagedSchema.safeParse({ ...validStaged, source: 'ftp' }).success).toBe(false);
    expect(ImportStagedSchema.safeParse({ ...validStaged, action: 'update' }).success).toBe(false);
    expect(ImportStagedSchema.safeParse({ ...validStaged, status: 'done' }).success).toBe(false);
    expect(ImportStagedSchema.safeParse({ ...validStaged, docType: 'pdf' }).success).toBe(false);
    const { fingerprint: _fp, ...missing } = validStaged;
    expect(ImportStagedSchema.safeParse(missing).success).toBe(false);
  });
});

describe('imports 契约：响应形状', () => {
  it('推送响应 = record + duplicated', () => {
    expect(
      ImportPushResponseSchema.safeParse({ record: validStaged, duplicated: false }).success,
    ).toBe(true);
    expect(ImportPushResponseSchema.safeParse({ record: validStaged }).success).toBe(false);
  });

  it('列表响应 = records 数组；查询 = status/source 可选', () => {
    expect(ImportStagedListResponseSchema.safeParse({ records: [validStaged] }).success).toBe(true);
    expect(ImportStagedQuerySchema.safeParse({}).success).toBe(true);
    expect(ImportStagedQuerySchema.safeParse({ status: 'failed', source: 'fetch' }).success).toBe(
      true,
    );
    expect(ImportStagedQuerySchema.safeParse({ status: 'done' }).success).toBe(false);
  });

  it('拉取运行响应 = fetched/staged/deleted 非负整数', () => {
    expect(
      ImportFetchRunResponseSchema.safeParse({ fetched: 3, staged: 2, deleted: 1 }).success,
    ).toBe(true);
    expect(ImportFetchRunResponseSchema.safeParse({ fetched: -1, staged: 0, deleted: 0 }).success)
      .toBe(false);
  });
});
