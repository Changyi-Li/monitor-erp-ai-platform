import { describe, expect, it } from 'vitest';
import {
  KbContentResponseSchema,
  KbCreateRequestSchema,
  KbDocumentDetailSchema,
  KbDocumentResponseSchema,
  KbDocumentSchema,
  KbListResponseSchema,
  KbUpdateRequestSchema,
  KbVersionSchema,
  KbVersionsResponseSchema,
} from '../src';

const validUuid = 'b1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const validIsoDate = '2026-08-06T02:30:00.000Z';

const validDoc = {
  id: validUuid,
  // #26 引入：归属（null = 全局文档，内部知识库）
  projectId: null,
  title: '标准操作手册：库存盘点',
  category: 'manual',
  docType: 'markdown',
  status: 'published',
  source: 'manual',
  hasDraft: false,
  createdBy: { id: validUuid, displayName: '实施顾问' },
  createdAt: validIsoDate,
  updatedAt: validIsoDate,
};

describe('kb 契约：KbDocumentSchema', () => {
  it('接受合法文档（创建人为 null 时字段为 null）', () => {
    expect(KbDocumentSchema.safeParse(validDoc).success).toBe(true);
    expect(KbDocumentSchema.safeParse({ ...validDoc, createdBy: null }).success).toBe(true);
  });

  it('拒绝空标题 / 非法分类 / 非法形态 / 非法状态', () => {
    expect(KbDocumentSchema.safeParse({ ...validDoc, title: '  ' }).success).toBe(false);
    expect(KbDocumentSchema.safeParse({ ...validDoc, category: 'wiki' }).success).toBe(false);
    expect(KbDocumentSchema.safeParse({ ...validDoc, docType: 'pdf' }).success).toBe(false);
    expect(KbDocumentSchema.safeParse({ ...validDoc, status: 'deleted' }).success).toBe(false);
  });
});

describe('kb 契约：KbCreateRequestSchema（discriminatedUnion）', () => {
  it('接受 markdown 分支（body 可省）', () => {
    expect(
      KbCreateRequestSchema.safeParse({
        docType: 'markdown',
        title: 'FAQ：登录问题',
        category: 'faq',
      }).success,
    ).toBe(true);
    expect(
      KbCreateRequestSchema.safeParse({
        docType: 'markdown',
        title: 'FAQ：登录问题',
        category: 'faq',
        body: '# 常见问题\n\n1. 忘记密码',
      }).success,
    ).toBe(true);
  });

  it('接受 file 分支；拒绝缺 docType / 坏分类 / 超限 base64', () => {
    expect(
      KbCreateRequestSchema.safeParse({
        docType: 'file',
        title: '验收文档',
        category: 'best_practice',
        fileName: '验收清单.pdf',
        contentType: 'application/pdf',
        base64: 'JVBERi0xLjQ=',
      }).success,
    ).toBe(true);
    expect(
      KbCreateRequestSchema.safeParse({ title: '无形态', category: 'faq' }).success,
    ).toBe(false);
    expect(
      KbCreateRequestSchema.safeParse({
        docType: 'file',
        title: 'x',
        category: 'manual',
        fileName: 'a.pdf',
        contentType: 'application/pdf',
        base64: 'a'.repeat(8_000_001),
      }).success,
    ).toBe(false);
  });
});

describe('kb 契约：KbUpdateRequestSchema', () => {
  it('接受任意字段子集（markdown 改正文 / 文件覆盖上传）', () => {
    expect(KbUpdateRequestSchema.safeParse({ body: '新内容' }).success).toBe(true);
    expect(KbUpdateRequestSchema.safeParse({ title: '新标题', category: 'faq' }).success).toBe(
      true,
    );
    expect(
      KbUpdateRequestSchema.safeParse({
        fileName: '新版.pdf',
        contentType: 'application/pdf',
        base64: 'AAA=',
      }).success,
    ).toBe(true);
  });

  it('拒绝空对象（无更新字段）与坏分类', () => {
    expect(KbUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(KbUpdateRequestSchema.safeParse({ category: 'wiki' }).success).toBe(false);
  });
});

describe('kb 契约：KbDocumentDetailSchema / 响应形状', () => {
  it('详情含当前可见内容 + hasDraft + viewerRole（markdown 分支 body、file 分支文件元信息）', () => {
    expect(
      KbDocumentDetailSchema.safeParse({ ...validDoc, body: '# 正文', hasDraft: false, viewerRole: 'internal' })
        .success,
    ).toBe(true);
    expect(
      KbDocumentDetailSchema.safeParse({
        ...validDoc,
        docType: 'file',
        file: { id: validUuid, name: 'a.pdf', contentType: 'application/pdf', size: 10 },
        hasDraft: true,
        viewerRole: 'customer',
      }).success,
    ).toBe(true);
    expect(KbDocumentResponseSchema.safeParse({ document: { ...validDoc, hasDraft: false, viewerRole: 'internal' } }).success).toBe(true);
    expect(KbListResponseSchema.safeParse({ documents: [validDoc], viewerRole: 'internal' }).success).toBe(true);
  });
});

describe('kb 契约：KbVersionSchema / 版本历史', () => {
  it('接受已发布版本（versionNumber 非 null）与草稿版本（versionNumber null）', () => {
    expect(
      KbVersionSchema.safeParse({
        id: validUuid,
        documentId: validUuid,
        versionNumber: 2,
        title: '旧标题',
        category: 'manual',
        body: '# 快照',
        publishedBy: { id: validUuid, displayName: '实施顾问' },
        publishedAt: validIsoDate,
        createdAt: validIsoDate,
      }).success,
    ).toBe(true);
    expect(
      KbVersionSchema.safeParse({
        id: validUuid,
        documentId: validUuid,
        versionNumber: null,
        title: '草稿标题',
        category: 'manual',
        publishedBy: null,
        publishedAt: null,
        createdAt: validIsoDate,
      }).success,
    ).toBe(true);
  });

  it('拒绝版本号 0 / 负数；版本历史响应形状', () => {
    expect(
      KbVersionSchema.safeParse({
        ...validDoc,
        versionNumber: 0,
        publishedBy: null,
        publishedAt: null,
      }).success,
    ).toBe(false);
    expect(KbVersionsResponseSchema.safeParse({ versions: [] }).success).toBe(true);
  });

  it('内容端点（markdown 回看）', () => {
    expect(KbContentResponseSchema.safeParse({ body: '# 内容' }).success).toBe(true);
    expect(KbContentResponseSchema.safeParse({ body: 'a'.repeat(200_001) }).success).toBe(false);
  });
});
