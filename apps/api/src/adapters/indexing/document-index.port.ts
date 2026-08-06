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
  /** 文档类型（issue #22 引用跳转路由依据；list 契约 DTO 不暴露） */
  documentType?: 'kb_document' | 'blueprint';
  /** blueprint → 项目 id（web 引用跳转 /projects/{projectId}/blueprints 需要） */
  projectId?: string;
  /** 导入时间戳（调试台显示） */
  updatedAt: Date;
}

/** 检索命中（内部客服 Agent 引用溯源；真实平台 = 多库联合检索接缝） */
export interface SearchHit {
  document: IndexedDocument;
  /** 相关度得分（memory 实现为关键词命中加权；真实平台用平台相关性分数） */
  score: number;
}

export interface DocumentIndexPort {
  /** 导入/覆盖文档（同 documentId 的旧版本被替换——平台 ID + 版本号幂等） */
  upsert(entry: IndexedDocument): Promise<void>;
  /** 从指定 scope 的 Index 删除（归档 → 下架） */
  remove(documentId: string, scope: string): Promise<void>;
  /** 列出某 scope 下已导入文档（调试台/测试可见性） */
  list(scope: string): Promise<IndexedDocument[]>;
  /**
   * 跨 scope 联合检索（issue #22 内部客服：后端注入 ['internal','customer'] 全量；
   * Phase 2 客户 Agent 注入 ['internal', tenantId] 只改调用处）。
   * 按相关度降序返回 top limit 条；query 空 → []。
   */
  search(query: string, scopes: string[], limit?: number): Promise<SearchHit[]>;
}
