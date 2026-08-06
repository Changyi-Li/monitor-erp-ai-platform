import { describe, expect, it } from 'vitest';
import {
  RagFailNextResponseSchema,
  RagIndexResponseSchema,
  RagSyncSchema,
  RagSyncsQuerySchema,
  RagSyncsResponseSchema,
} from '../src';

const validUuid = 'b1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const validIsoDate = '2026-08-06T02:30:00.000Z';

const validSync = {
  id: validUuid,
  documentId: validUuid,
  documentType: 'kb_document' as const,
  versionNumber: 2,
  action: 'upsert' as const,
  scope: 'internal' as const,
  tenantId: null,
  title: '登录问题 FAQ',
  status: 'succeeded' as const,
  attempt: 0,
  lastError: null,
  createdAt: validIsoDate,
  updatedAt: validIsoDate,
};

describe('rag 契约：同步任务', () => {
  it('接受合法任务行（internal scope tenantId 可空）', () => {
    expect(RagSyncSchema.safeParse(validSync).success).toBe(true);
  });

  it('接受 customer scope + tenantId + 失败重试态', () => {
    expect(
      RagSyncSchema.safeParse({
        ...validSync,
        scope: 'customer',
        tenantId: validUuid,
        status: 'failed',
        attempt: 3,
        lastError: 'fake Index 注入失败（调试）',
      }).success,
    ).toBe(true);
  });

  it('拒绝非法枚举 / 版本号非正', () => {
    expect(RagSyncSchema.safeParse({ ...validSync, status: 'done' }).success).toBe(false);
    expect(RagSyncSchema.safeParse({ ...validSync, scope: 'other' }).success).toBe(false);
    expect(RagSyncSchema.safeParse({ ...validSync, documentType: 'drawio' }).success).toBe(false);
    expect(RagSyncSchema.safeParse({ ...validSync, action: 'update' }).success).toBe(false);
    expect(RagSyncSchema.safeParse({ ...validSync, versionNumber: 0 }).success).toBe(false);
  });

  it('列表响应为 { syncs }；查询参数筛选枚举合法', () => {
    expect(RagSyncsResponseSchema.safeParse({ syncs: [validSync] }).success).toBe(true);
    expect(RagSyncsResponseSchema.safeParse({ syncs: [] }).success).toBe(true);
    expect(RagSyncsResponseSchema.safeParse({}).success).toBe(false);
    expect(RagSyncsQuerySchema.safeParse({}).success).toBe(true);
    expect(RagSyncsQuerySchema.safeParse({ status: 'processing', scope: 'customer' }).success).toBe(true);
    expect(RagSyncsQuerySchema.safeParse({ status: 'done' }).success).toBe(false);
  });
});

describe('rag 契约：Index 可见性与调试注入', () => {
  it('Index 响应为 { scope, documents }', () => {
    expect(
      RagIndexResponseSchema.safeParse({
        scope: 'internal',
        documents: [{ documentId: validUuid, versionNumber: 1, title: '操作手册', contentType: null, updatedAt: validIsoDate }],
      }).success,
    ).toBe(true);
    expect(RagIndexResponseSchema.safeParse({ scope: 'other', documents: [] }).success).toBe(false);
  });

  it('调试注入响应为 { armed }', () => {
    expect(RagFailNextResponseSchema.safeParse({ armed: true }).success).toBe(true);
    expect(RagFailNextResponseSchema.safeParse({}).success).toBe(false);
  });
});
