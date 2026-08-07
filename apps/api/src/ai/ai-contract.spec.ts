import { describe, expect, it } from 'vitest';
import {
  AiConfigResponseSchema,
  AiImageParsingRequestSchema,
  AiImageParsingResponseSchema,
} from '@monitor/contracts';

describe('AI 契约：图片解析请求（zod 校验边界）', () => {
  it('合法请求通过（base64 + contentType + prompt 可选）', () => {
    const parsed = AiImageParsingRequestSchema.safeParse({
      image: { base64: 'iVBORw0KGgo=', contentType: 'image/png' },
      prompt: '提取审批流',
    });
    expect(parsed.success).toBe(true);
  });

  it('无 prompt 也可通过', () => {
    const parsed = AiImageParsingRequestSchema.safeParse({
      image: { base64: 'iVBORw0KGgo=', contentType: 'image/png' },
    });
    expect(parsed.success).toBe(true);
  });

  it('base64 超 8M 字符 → 拒绝（上传通道上限）', () => {
    const parsed = AiImageParsingRequestSchema.safeParse({
      image: { base64: 'a'.repeat(8_000_001), contentType: 'image/png' },
    });
    expect(parsed.success).toBe(false);
  });

  it('base64 为空 → 拒绝', () => {
    const parsed = AiImageParsingRequestSchema.safeParse({
      image: { base64: '', contentType: 'image/png' },
    });
    expect(parsed.success).toBe(false);
  });

  it('contentType 为空 → 拒绝', () => {
    const parsed = AiImageParsingRequestSchema.safeParse({
      image: { base64: 'iVBORw0KGgo=', contentType: '' },
    });
    expect(parsed.success).toBe(false);
  });

  it('prompt 超 2000 字符 → 拒绝', () => {
    const parsed = AiImageParsingRequestSchema.safeParse({
      image: { base64: 'iVBORw0KGgo=', contentType: 'image/png' },
      prompt: 'x'.repeat(2001),
    });
    expect(parsed.success).toBe(false);
  });
});

describe('AI 契约：响应 schema（safeParse 形状）', () => {
  it('图片解析响应：content + usage', () => {
    const parsed = AiImageParsingResponseSchema.safeParse({
      content: '流程：1. 登录 2. 审批',
      usage: { model: 'memory', inputTokens: 100, outputTokens: 25 },
    });
    expect(parsed.success).toBe(true);
  });

  it('usage 字段缺失/token 负数 → 拒绝', () => {
    expect(
      AiImageParsingResponseSchema.safeParse({ content: 'x', usage: { model: 'm' } }).success,
    ).toBe(false);
    expect(
      AiImageParsingResponseSchema.safeParse({ content: 'x', usage: { model: 'm', inputTokens: -1, outputTokens: 0 } }).success,
    ).toBe(false);
  });

  it('配置响应：scenes 数组（固定序 + 全字段）', () => {
    const parsed = AiConfigResponseSchema.safeParse({
      scenes: [
        { scene: 'agent', label: '客服问答', driver: 'memory', model: 'memory', source: 'default', enabled: true },
        { scene: 'document_parsing', label: '文档解析', driver: 'openai', model: 'qwen-vl-max', source: 'scene', enabled: false, reason: '缺少 LLM_OPENAI_API_KEY' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('配置响应：非法 scene 枚举/缺 label → 拒绝', () => {
    expect(
      AiConfigResponseSchema.safeParse({
        scenes: [{ scene: 'nope', label: 'x', driver: 'memory', model: 'memory', source: 'default', enabled: true }],
      }).success,
    ).toBe(false);
    expect(
      AiConfigResponseSchema.safeParse({
        scenes: [{ scene: 'agent', driver: 'memory', model: 'memory', source: 'default', enabled: true }],
      }).success,
    ).toBe(false);
  });
});
