import type { IssueStatus } from '@monitor/shared';

/**
 * 问题状态机（spec §3.5，issue #15 验收 ②）：严格线性前进
 * 新建 → 处理中 → 已解决 → 已关闭，仅相邻前进合法，其余一律拒绝。
 * 纯函数便于单元测试（spec Testing Decisions：状态机单测）。
 */
export const ISSUE_TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  new: ['in_progress'],
  in_progress: ['resolved'],
  resolved: ['closed'],
  closed: [],
};

export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  return ISSUE_TRANSITIONS[from].includes(to);
}
