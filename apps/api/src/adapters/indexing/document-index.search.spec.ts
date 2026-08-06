import { describe, expect, it } from 'vitest';
import { MemoryDocumentIndexAdapter } from './memory-document-index.adapter';
import type { IndexedDocument } from './document-index.port';

function doc(overrides: Partial<IndexedDocument>): IndexedDocument {
  return {
    documentId: 'd1',
    versionNumber: 1,
    scope: 'internal',
    title: '登录问题 FAQ',
    content: '无法登录时请检查账号与密码。',
    updatedAt: new Date('2026-08-06T00:00:00.000Z'),
    ...overrides,
  };
}

describe('memory 文档索引：跨 scope 联合检索', () => {
  const idx = new MemoryDocumentIndexAdapter();

  it('title 命中权重高于 content（title 命中排前）', async () => {
    await idx.upsert(doc({ documentId: 'kb-title', title: '订单审批流程', content: '订单创建后进入审批。' }));
    await idx.upsert(doc({ documentId: 'kb-content', title: '仓库管理', content: '订单出库需要审批签字。' }));
    const hits = await idx.search('订单 审批', ['internal'], 5);
    expect(hits[0].document.documentId).toBe('kb-title');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('scope 过滤：只搜传入 scope', async () => {
    await idx.upsert(doc({ documentId: 'cust-blueprint', scope: 'customer', title: '客户订单蓝图', content: '销售订单流程。' }));
    const internalOnly = await idx.search('客户订单蓝图', ['internal']);
    expect(internalOnly.some((h) => h.document.documentId === 'cust-blueprint')).toBe(false);
    const all = await idx.search('客户订单蓝图', ['internal', 'customer']);
    expect(all.some((h) => h.document.documentId === 'cust-blueprint')).toBe(true);
  });

  it('top N 截断', async () => {
    for (let i = 0; i < 7; i++) {
      await idx.upsert(doc({ documentId: `kb-${i}`, title: `库存盘点流程${i}`, content: '库存盘点操作。' }));
    }
    const hits = await idx.search('库存盘点', ['internal'], 3);
    expect(hits.length).toBe(3);
  });

  it('空 query → 空结果', async () => {
    expect(await idx.search('   ', ['internal'])).toEqual([]);
  });
});
