import { describe, expect, it } from 'vitest';
import { ISSUE_STATUSES } from '@monitor/shared';
import { canTransition, ISSUE_TRANSITIONS } from './issue-status';

/**
 * 问题状态机（issue #15 验收 ②）：严格线性前进
 * 新建 → 处理中 → 已解决 → 已关闭，仅相邻前进合法，其余一律拒绝。
 */
describe('问题状态机', () => {
  it('合法流转：三条相邻前进边', () => {
    expect(canTransition('new', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'resolved')).toBe(true);
    expect(canTransition('resolved', 'closed')).toBe(true);
  });

  it('非法流转：跳过中间态 / 回退 / 原地 / 已关闭后再流转', () => {
    expect(canTransition('new', 'resolved')).toBe(false);
    expect(canTransition('new', 'closed')).toBe(false);
    expect(canTransition('in_progress', 'closed')).toBe(false);
    expect(canTransition('in_progress', 'new')).toBe(false);
    expect(canTransition('resolved', 'in_progress')).toBe(false);
    expect(canTransition('closed', 'new')).toBe(false);
    expect(canTransition('closed', 'in_progress')).toBe(false);
    expect(canTransition('closed', 'resolved')).toBe(false);
    expect(canTransition('closed', 'closed')).toBe(false);
  });

  it('每个状态至多一个合法目标（线性）', () => {
    for (const status of ISSUE_STATUSES) {
      expect(ISSUE_TRANSITIONS[status].length).toBeLessThanOrEqual(1);
    }
  });

  it('新问题是唯一初始态，已关闭是唯一终态', () => {
    expect(ISSUE_TRANSITIONS.closed).toEqual([]);
    const sources = Object.keys(ISSUE_TRANSITIONS);
    expect(sources).toEqual(['new', 'in_progress', 'resolved', 'closed']);
  });
});
