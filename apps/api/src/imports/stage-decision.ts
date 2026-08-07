/**
 * 导入暂存决策（issue #25，spec §4.4 增量去重）：按幂等键 (source, sourceKey, action='upsert')
 * 既有行 + 内容指纹 + kb 文档存在性，决定「插入 / 真重复 / 原地重置」。
 * 纯函数（spec Testing Decisions 单测惯例）：
 *
 * | 既有 upsert 行 | 指纹相同 | kb 文档存在 | 决策 |
 * |---|---|---|---|
 * | 无 | — | — | insert（新文档入） |
 * | 有 | ✅ | ✅ | duplicate（真重复：不动内容，duplicateCount+1） |
 * | 有 | ❌ | — | reset（变更更新：新指纹/内容，status→pending） |
 * | 有 | ✅ | ❌ | reset（删后回炉：外部重推已删内容 = 视为新推送） |
 *
 * delete 动作不经此函数（apply 幂等 + onConflictDoNothing 去重）。
 */

export type StageDecision =
  | { kind: 'insert' } // 新行
  | { kind: 'duplicate' } // 真重复：仅 duplicateCount+1
  | { kind: 'reset' }; // 原地重置（变更 / 删后回炉）

export interface StageDecisionInput {
  existing: { fingerprint: string } | undefined; // 既有 upsert 行
  fingerprint: string; // 新内容指纹
  kbDocExists: boolean; // externalKey 对应 kb 文档存在
}

export function decideStage(input: StageDecisionInput): StageDecision {
  if (!input.existing) {
    return { kind: 'insert' };
  }
  if (input.existing.fingerprint === input.fingerprint && input.kbDocExists) {
    return { kind: 'duplicate' };
  }
  return { kind: 'reset' };
}
