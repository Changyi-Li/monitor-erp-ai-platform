import type { DocumentIndexPort, IndexedDocument, SearchHit } from './document-index.port';

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

  async search(query: string, scopes: string[], limit = 5): Promise<SearchHit[]> {
    // 中文切词：去全半角标点 → 按空白切 → 4 字以上词补 2-4 字 n-gram 窗口
    //（「如何登录？」→ 词元 '如何' '何登' '登录' …，与文档「登录问题」共享 '登录' 命中）
    const normalized = query
      .toLowerCase()
      .replace(/[\s，。！？、；：,.!?;:()（）\-"'“”‘’【】\[\]《》]+/g, ' ');
    const rawTerms = normalized.split(/\s+/).filter((t) => t.length > 0);
    const terms = new Set<string>();
    for (const t of rawTerms) {
      // 所有词都补 2-4 字 n-gram 窗口（「如何登录」→ '如何' '何登' '登录' …，
      // 与文档「登录问题」共享 '登录' 命中）；短词（≤4 字）整词也参与
      const maxLen = Math.min(4, t.length);
      for (let len = 2; len <= maxLen; len++) {
        for (let i = 0; i + len <= t.length; i++) {
          terms.add(t.slice(i, i + len));
        }
      }
      if (t.length <= 4) terms.add(t);
    }
    if (terms.size === 0) return [];

    const hits: SearchHit[] = [];
    for (const scope of scopes) {
      for (const doc of this.index.get(scope)?.values() ?? []) {
        // 打分：title 命中权重 ×3、content ×1（每词元对每个字段至多计一次）
        const title = doc.title.toLowerCase();
        const content = doc.content.toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (title.includes(term)) score += 3;
          if (content.includes(term)) score += 1;
        }
        if (score > 0) hits.push({ document: doc, score });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}
