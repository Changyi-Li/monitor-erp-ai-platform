import { describe, expect, it } from 'vitest';
import { decideStage } from './stage-decision';

const F = 'a'.repeat(64); // 指纹（sha256 hex 形态占位）

describe('decideStage：暂存决策矩阵（issue #25 增量去重）', () => {
  it('无既有行 → insert（新文档入）', () => {
    expect(decideStage({ existing: undefined, fingerprint: F, kbDocExists: false })).toEqual({
      kind: 'insert',
    });
    expect(decideStage({ existing: undefined, fingerprint: F, kbDocExists: true })).toEqual({
      kind: 'insert', // kb 有文档但暂存无行（历史已消费）→ 仍插新行
    });
  });

  it('既有行 + 指纹相同 + kb 文档存在 → duplicate（真重复：不动内容，duplicateCount+1）', () => {
    expect(
      decideStage({ existing: { fingerprint: F }, fingerprint: F, kbDocExists: true }),
    ).toEqual({ kind: 'duplicate' });
  });

  it('既有行 + 指纹不同 → reset（变更更新：新指纹/内容，status→pending）——无论 kb 是否存在', () => {
    expect(
      decideStage({ existing: { fingerprint: F }, fingerprint: F + 'b', kbDocExists: true }),
    ).toEqual({ kind: 'reset' });
    expect(
      decideStage({ existing: { fingerprint: F }, fingerprint: F + 'b', kbDocExists: false }),
    ).toEqual({ kind: 'reset' });
  });

  it('既有行 + 指纹相同 + kb 文档不存在 → reset（删后回炉：外部重推已删内容 = 视为新推送）', () => {
    expect(
      decideStage({ existing: { fingerprint: F }, fingerprint: F, kbDocExists: false }),
    ).toEqual({ kind: 'reset' });
  });

  it('delete 动作不经此函数（apply 幂等 + onConflictDoNothing 去重）——决策输入不含 action', () => {
    // 决策只消费 (existing, fingerprint, kbDocExists) 三个输入，delete 通道独立走 insert 幂等
    const input = { existing: undefined, fingerprint: 'delete', kbDocExists: false };
    expect(decideStage(input)).toEqual({ kind: 'insert' });
  });
});
