import type { DocumentIndexPort, IndexedDocument } from './document-index.port';

/**
 * 内存实现：scope → documentId → 文档 的进程内 Map（开发/测试默认）。
 * 重启即空（真实平台接入后由平台持久化）。
 * `failNextUpsertOnce()` 为调试开关（RAG 调试台「制造一次失败」演示指数退避重试）。
 */
export class MemoryDocumentIndexAdapter implements DocumentIndexPort {
  private readonly index = new Map<string, Map<string, IndexedDocument>>();
  private failNext = false;

  /** 下一次 upsert 抛错（仅一次；用于演示同步失败 → 指数退避重试） */
  failNextUpsertOnce(): void {
    this.failNext = true;
  }

  async upsert(entry: IndexedDocument): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('fake Index 注入失败（调试）');
    }
    let byDoc = this.index.get(entry.scope);
    if (!byDoc) {
      byDoc = new Map();
      this.index.set(entry.scope, byDoc);
    }
    byDoc.set(entry.documentId, { ...entry, updatedAt: new Date() });
  }

  async remove(documentId: string, scope: string): Promise<void> {
    this.index.get(scope)?.delete(documentId);
  }

  async list(scope: string): Promise<IndexedDocument[]> {
    return [...(this.index.get(scope)?.values() ?? [])];
  }
}
