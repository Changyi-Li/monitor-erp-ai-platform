/**
 * 外部导入源适配端口（issue #25 定时拉取通道）：拉取外部项目文档清单。
 * 平台无关约束（同 StoragePort/MQ/DocumentIndexPort 先例）——实现负责
 * 清单获取 + 格式映射（markdown/html → docType='markdown'；pdf/word →
 * docType='file'，contentUrl 二次拉取）与超限丢弃，业务层只消费结构化条目。
 */

/** 导入源适配端口注入 token（独立于 module 文件，避免模块循环——同 STORAGE/MQ/IDX 惯例） */
export const IMPORT_SOURCE = Symbol('IMPORT_SOURCE');
export interface ImportSourceItem {
  sourceKey: string; // 外部源文档唯一键（同通道内须稳定）
  title: string;
  category: 'manual' | 'faq' | 'best_practice';
  docType: 'markdown' | 'file';
  body?: string; // markdown 类正文（HTML 原文同通道，渲染 escape-first）
  fileName?: string;
  contentType?: string;
  base64?: string; // 文件类（contentUrl 已拉取并转 base64）
  updatedAt?: string; // 外部源更新时间（原样进 metadata，去重以内容指纹为准）
}

export interface ImportSourcePort {
  /** 拉取完整清单（含正文/文件内容解析） */
  fetchManifest(): Promise<ImportSourceItem[]>;
}
