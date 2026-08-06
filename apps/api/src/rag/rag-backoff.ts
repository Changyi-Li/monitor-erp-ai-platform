/**
 * 指数退避（spec 56「同步失败自动重试（指数退避）」）：
 * 第 attempt 次失败后的下次重试延迟 = min(2^attempt, 60) 秒。
 * attempt 从 1 起：1→2s, 2→4s, 3→8s, 4→16s, 5→32s, ≥6→60s（cap）。
 * 纯函数（spec Testing Decisions：幂等键/退避等纯逻辑单测）。
 */
export function backoffDelayMs(attempt: number): number {
  return Math.min(60_000, 2 ** Math.max(attempt, 1) * 1_000);
}
