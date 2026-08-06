import type { RagScope, RagSyncStatus } from '@monitor/shared';

/** RAG 同步状态中文标签 + 颜色（调试台状态流转面板） */
export const RAG_SYNC_STATUS_LABELS: Record<RagSyncStatus, string> = {
  queued: '排队中',
  processing: '处理中',
  succeeded: '已完成',
  failed: '失败',
};

export const RAG_SYNC_STATUS_COLORS: Record<RagSyncStatus, string> = {
  queued: '#92400e',
  processing: '#1d4ed8',
  succeeded: '#15803d',
  failed: '#b91c1c',
};

/** RAG Index scope 中文标签 */
export const RAG_SCOPE_LABELS: Record<RagScope, string> = {
  internal: '内部 Index',
  customer: '客户 Index',
};
