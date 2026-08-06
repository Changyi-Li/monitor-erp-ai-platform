/**
 * 文档索引适配端口（spec「RAG 经 DocumentIndexPort 适配层，平台无关」，
 * 候选 Dify/RagFlow/百炼；真实接入只改 INDEX_DRIVER 配置）。
 * 本期 memory fake 验证「发布 → 导入 → 状态流转 → 失败重试 → 幂等 → scope 路由」管线；
 * 真实平台接入后由平台负责持久化与检索，本接口面保持不变。
 */
export interface IndexedDocument {
  /** 平台文档 ID（幂等键一部分） */
  documentId: string;
  /** 文档版本号（幂等键另一部分） */
  versionNumber: number;
  /** 路由目标：'internal' = 内部 Index；'customer' = 客户 Index */
  scope: string;
  title: string;
  /** 索引正文（文本；文件类文档本期只索引元信息） */
  content: string;
  contentType?: string;
  /** 导入时间戳（调试台显示） */
  updatedAt: Date;
}

export interface DocumentIndexPort {
  /** 导入/覆盖文档（同 documentId 的旧版本被替换——平台 ID + 版本号幂等） */
  upsert(entry: IndexedDocument): Promise<void>;
  /** 从指定 scope 的 Index 删除（归档 → 下架） */
  remove(documentId: string, scope: string): Promise<void>;
  /** 列出某 scope 下已导入文档（调试台/测试可见性） */
  list(scope: string): Promise<IndexedDocument[]>;
}
