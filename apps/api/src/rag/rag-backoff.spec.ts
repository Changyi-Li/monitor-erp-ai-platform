import { describe, expect, it } from 'vitest';
import { backoffDelayMs } from './rag-backoff';

describe('rag-backoff：指数退避（spec 56）', () => {
  it('attempt 从 1 起递增：2s → 4s → 8s → 16s → 32s', () => {
    expect(backoffDelayMs(1)).toBe(2_000);
    expect(backoffDelayMs(2)).toBe(4_000);
    expect(backoffDelayMs(3)).toBe(8_000);
    expect(backoffDelayMs(4)).toBe(16_000);
    expect(backoffDelayMs(5)).toBe(32_000);
  });

  it('cap 60s（attempt ≥ 6 不再翻倍）', () => {
    expect(backoffDelayMs(6)).toBe(60_000);
    expect(backoffDelayMs(10)).toBe(60_000);
  });

  it('非正 attempt 收敛到 2s（防御）', () => {
    expect(backoffDelayMs(0)).toBe(2_000);
    expect(backoffDelayMs(-3)).toBe(2_000);
  });
});
