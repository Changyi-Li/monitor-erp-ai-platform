import { describe, expect, it } from 'vitest';
import {
  UsageSummaryQuerySchema,
  UsageSummaryResponseSchema,
  UsageTrendQuerySchema,
  UsageTrendResponseSchema,
} from '../src';

const validUuid = '8f14e45f-ea9f-4f4d-b33e-3a8d1f2b0c11';
const validIsoDate = '2026-08-06T02:30:00.000Z';

const validEntry = {
  key: validUuid,
  name: '示例客户',
  calls: 12,
  inputTokens: 3400,
  outputTokens: 1200,
  costUsd: null,
};

const validSummary = {
  total: { calls: 12, inputTokens: 3400, outputTokens: 1200, totalCostUsd: null },
  byCustomer: [validEntry],
  byProject: [{ ...validEntry, key: null, name: '未归属' }],
  byScene: [{ key: 'agent', name: 'agent', calls: 12, inputTokens: 3400, outputTokens: 1200, costUsd: null }],
  byModel: [{ key: 'memory', name: 'memory', calls: 12, inputTokens: 3400, outputTokens: 1200, costUsd: null }],
};

describe('usage 契约：summary 查询', () => {
  it('接受全空查询（默认全量）', () => {
    expect(UsageSummaryQuerySchema.safeParse({}).success).toBe(true);
  });

  it('接受全部筛选字段', () => {
    expect(
      UsageSummaryQuerySchema.safeParse({
        customerId: validUuid,
        projectId: validUuid,
        scene: 'agent',
        model: 'memory',
        from: validIsoDate,
        to: validIsoDate,
      }).success,
    ).toBe(true);
  });

  it('拒绝非法枚举（scene）/非法 uuid / 非法日期', () => {
    expect(UsageSummaryQuerySchema.safeParse({ scene: 'manual' }).success).toBe(false);
    expect(UsageSummaryQuerySchema.safeParse({ customerId: 'x' }).success).toBe(false);
    expect(UsageSummaryQuerySchema.safeParse({ from: '2026-08-06' }).success).toBe(false);
  });
});

describe('usage 契约：trend 查询', () => {
  it('granularity 默认 day；month 合法；非法值拒绝', () => {
    expect(UsageTrendQuerySchema.safeParse({}).success).toBe(true);
    expect(UsageTrendQuerySchema.parse({}).granularity).toBe('day');
    expect(UsageTrendQuerySchema.safeParse({ granularity: 'month' }).success).toBe(true);
    expect(UsageTrendQuerySchema.safeParse({ granularity: 'hour' }).success).toBe(false);
  });
});

describe('usage 契约：summary 响应', () => {
  it('接受合法汇总（含未归属 null key 与 null cost）', () => {
    expect(UsageSummaryResponseSchema.safeParse(validSummary).success).toBe(true);
  });

  it('拒绝负数 token / 缺失维度数组', () => {
    expect(
      UsageSummaryResponseSchema.safeParse({
        ...validSummary,
        total: { calls: -1, inputTokens: 0, outputTokens: 0, totalCostUsd: null },
      }).success,
    ).toBe(false);
    const { byModel: _dropped, ...rest } = validSummary;
    expect(UsageSummaryResponseSchema.safeParse(rest).success).toBe(false);
  });
});

describe('usage 契约：trend 响应', () => {
  it('接受合法趋势点（bucket ISO 时间 + 非负计数）', () => {
    expect(
      UsageTrendResponseSchema.safeParse({
        points: [{ bucket: validIsoDate, calls: 2, inputTokens: 600, outputTokens: 200 }],
      }).success,
    ).toBe(true);
  });

  it('拒绝非法 bucket / 非整数 token', () => {
    expect(
      UsageTrendResponseSchema.safeParse({
        points: [{ bucket: 'not-a-date', calls: 2, inputTokens: 600, outputTokens: 200 }],
      }).success,
    ).toBe(false);
    expect(
      UsageTrendResponseSchema.safeParse({
        points: [{ bucket: validIsoDate, calls: 2.5, inputTokens: 600, outputTokens: 200 }],
      }).success,
    ).toBe(false);
  });
});
