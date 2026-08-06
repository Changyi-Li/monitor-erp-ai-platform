import { RAG_SCOPES, RAG_SYNC_STATUSES } from '@monitor/shared';
import { z } from 'zod';

/**
 * RAG 同步任务（issue #21，spec §4.3「发布即同步」）：
 * 发布/归档/恢复 → 事务入队 → Worker 异步导入（幂等：文档 ID + 版本号 + action）→ 状态流转。
 * scope 路由：kb 文档 → internal，蓝图 → customer（tenantId 冗余）。
 */

/** 同步任务行（调试台/同步状态查询） */
export const RagSyncSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  documentType: z.enum(['kb_document', 'blueprint']),
  versionNumber: z.number().int().positive(),
  action: z.enum(['upsert', 'delete']),
  scope: z.enum(RAG_SCOPES),
  tenantId: z.uuid().nullable().optional(),
  title: z.string(),
  status: z.enum(RAG_SYNC_STATUSES),
  attempt: z.number().int().nonnegative(),
  lastError: z.string().nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type RagSync = z.output<typeof RagSyncSchema>;

/** 同步任务列表查询（状态/scope 筛选；非法枚举 → 400） */
export const RagSyncsQuerySchema = z.object({
  status: z.enum(RAG_SYNC_STATUSES).optional(),
  scope: z.enum(RAG_SCOPES).optional(),
});
export type RagSyncsQuery = z.output<typeof RagSyncsQuerySchema>;

export const RagSyncsResponseSchema = z.object({ syncs: z.array(RagSyncSchema) });
export type RagSyncsResponse = z.output<typeof RagSyncsResponseSchema>;

/** fake Index 可见文档（调试台「fake Index 中可见/归档后消失」） */
export const RagIndexResponseSchema = z.object({
  scope: z.enum(RAG_SCOPES),
  documents: z.array(
    z.object({
      documentId: z.uuid(),
      versionNumber: z.number().int().positive(),
      title: z.string(),
      contentType: z.string().nullable().optional(),
      updatedAt: z.iso.datetime(),
    }),
  ),
});
export type RagIndexResponse = z.output<typeof RagIndexResponseSchema>;

/** 调试注入响应（「制造一次失败」已武装） */
export const RagFailNextResponseSchema = z.object({ armed: z.boolean() });
export type RagFailNextResponse = z.output<typeof RagFailNextResponseSchema>;
