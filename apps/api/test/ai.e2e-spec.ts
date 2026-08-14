import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  AiConfigResponseSchema,
  AiImageParsingResponseSchema,
  UsageSummaryResponseSchema,
} from '@monitor/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { IMAGE_PARSE_SYSTEM } from '../src/ai/ai.service';
import { connectOwner, resetTestDb } from './setup-test-db';

/**
 * 多模态与场景化多模型 e2e（issue #24 验收）：
 * - ① 图片解析（scene='document_parsing' 经场景路由 → memory 确定性模板 + usage 可精确断言）
 * - ② 计量链路：解析后 usage summary 按 document_parsing 场景计数（复用 usage API）
 * - ③ 无效输入 → 400（base64 超限/空、contentType 非 image/*）
 * - ④ 场景 → 模型映射配置（GET /api/ai/config：4 场景固定序、默认 memory、契约 safeParse）
 * - ⑤ 权限：客户 403 / 未认证 401（内部专属）
 */

describe('AI e2e：多模态与场景化多模型', () => {
  let app: NestFastifyApplication;

  const password = 'password123';
  const internalTokenKey = 'internal-token';
  const customerTokenKey = 'customer-token';
  const tokens: Record<string, string> = {};

  /** 1x1 透明 PNG（≈120 字符 base64，解码 <6MB 上限） */
  const PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const PNG_CONTENT_TYPE = 'image/png';
  const PARSE_PROMPT = '提取审批流';

  async function register(email: string): Promise<{ id: string; token: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password, displayName: email.split('@')[0] },
    });
    expect(res.statusCode).toBe(201);
    const { user } = res.json() as { user: { id: string } };
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(login.statusCode).toBe(200);
    return { id: user.id, token: (login.json() as { accessToken: string }).accessToken };
  }

  async function parseImage(payload: unknown, token: string): Promise<{ statusCode: number; json: () => unknown }> {
    return app.inject({
      method: 'POST',
      url: '/api/ai/image-parsing',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  /** 每次断言都重新抓取（禁止复用旧响应——数据随调用增长） */
  async function fetchUsageByScene(scene: string): Promise<number> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/usage/summary?scene=${scene}`,
      headers: { authorization: `Bearer ${tokens[internalTokenKey]}` },
    });
    expect(res.statusCode).toBe(200);
    const parsed = UsageSummaryResponseSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    return parsed.data!.total.calls;
  }

  beforeAll(async () => {
    await resetTestDb();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    // bodyLimit 对齐 main.ts 生产配置（10MB，JSON base64 上传通道）；缺省 1MB 会在 zod 前 413
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ bodyLimit: 10_000_000 }),
    );
    app.setGlobalPrefix('api');
    await app.init();

    const internal = await register('internal@corp.test');
    const customer = await register('customer@tenant-a.test');

    const owner = connectOwner();
    try {
      await owner`update users set role = 'customer_user' where id = ${customer.id}`;
      const [c] = await owner`insert into customers (name) values ('客户A') returning id`;
      await owner`insert into user_tenants (user_id, customer_id) values (${customer.id}, ${c.id})`;
    } finally {
      await owner.end();
    }
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'customer@tenant-a.test', password },
    });
    expect(login.statusCode).toBe(200);
    tokens[internalTokenKey] = internal.token;
    tokens[customerTokenKey] = (login.json() as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('验收 ①：图片解析（多模态 → 结构化结果 + 用量）', () => {
    it('内部用户解析合法 PNG → 200 + 确定性流程模板 + usage 精确断言（model=memory）', async () => {
      const before = await fetchUsageByScene('document_parsing');
      const res = await parseImage(
        {
          image: { base64: PNG_BASE64, contentType: PNG_CONTENT_TYPE },
          prompt: PARSE_PROMPT,
        },
        tokens[internalTokenKey],
      );
      expect(res.statusCode).toBe(200);
      const parsed = AiImageParsingResponseSchema.safeParse(res.json());
      expect(parsed.success).toBe(true); // 契约 safeParse
      const { content, usage } = parsed.data!;

      // memory fake 确定性流程模板
      expect(content).toContain('流程解析（memory 驱动模拟）');
      expect(content).toContain('结构化输出');

      // usage：model=memory；inputTokens = ceil((system + prompt + dataURL)/4)；outputTokens = ceil(content/4)
      expect(usage.model).toBe('memory');
      const dataUrl = `data:${PNG_CONTENT_TYPE};base64,${PNG_BASE64}`;
      const inputChars = IMAGE_PARSE_SYSTEM.length + PARSE_PROMPT.length + dataUrl.length;
      expect(usage.inputTokens).toBe(Math.ceil(inputChars / 4));
      expect(usage.outputTokens).toBe(Math.ceil(content.length / 4));

      // 计量链路：document_parsing 场景计数 +1（每次查询重新抓取）
      const after = await fetchUsageByScene('document_parsing');
      expect(after).toBe(before + 1);
    });

    it('再次解析 → 计数继续增长（每次调用独立落库）', async () => {
      const before = await fetchUsageByScene('document_parsing');
      await parseImage(
        { image: { base64: PNG_BASE64, contentType: PNG_CONTENT_TYPE } },
        tokens[internalTokenKey],
      );
      expect(await fetchUsageByScene('document_parsing')).toBe(before + 1);
    });
  });

  describe('验收 ③：无效输入 → 400', () => {
    it('base64 为空 → 400', async () => {
      const res = await parseImage(
        { image: { base64: '', contentType: PNG_CONTENT_TYPE } },
        tokens[internalTokenKey],
      );
      expect(res.statusCode).toBe(400);
    });

    it('base64 超 8M 字符 → 400（zod 上传通道上限）', async () => {
      const res = await parseImage(
        { image: { base64: 'a'.repeat(8_000_001), contentType: PNG_CONTENT_TYPE } },
        tokens[internalTokenKey],
      );
      expect(res.statusCode).toBe(400);
    });

    it('contentType 非 image/* → 400', async () => {
      const res = await parseImage(
        { image: { base64: PNG_BASE64, contentType: 'text/plain' } },
        tokens[internalTokenKey],
      );
      expect(res.statusCode).toBe(400);
    });
  });

  describe('验收 ④：场景 → 模型映射配置', () => {
    it('GET /api/ai/config → 200 + 契约 + 4 场景固定序 + 默认 memory/available', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/ai/config',
        headers: { authorization: `Bearer ${tokens[internalTokenKey]}` },
      });
      expect(res.statusCode).toBe(200);
      const parsed = AiConfigResponseSchema.safeParse(res.json());
      expect(parsed.success).toBe(true);
      const scenes = parsed.data!.scenes;
      expect(scenes.map((s) => s.scene)).toEqual([
        'agent',
        'document_parsing',
        'manual_generation',
        'embedding',
      ]);
      for (const s of scenes) {
        expect(s.label.length).toBeGreaterThan(0);
        expect(s.driver).toBe('memory'); // 测试环境未配 openai → 全部 memory
        expect(s.model).toBe('memory');
        expect(s.source).toBe('global'); // .env.test 定义了 LLM_DRIVER=memory → 全局兜底（非内置 default）
        expect(s.enabled).toBe(true);
      }
    });
  });

  describe('验收 ⑤：权限（内部专属）', () => {
    it('客户用户访问 image-parsing/config → 403；未认证 → 401', async () => {
      const forbiddenParse = await parseImage(
        { image: { base64: PNG_BASE64, contentType: PNG_CONTENT_TYPE } },
        tokens[customerTokenKey],
      );
      expect(forbiddenParse.statusCode).toBe(403);

      const forbiddenConfig = await app.inject({
        method: 'GET',
        url: '/api/ai/config',
        headers: { authorization: `Bearer ${tokens[customerTokenKey]}` },
      });
      expect(forbiddenConfig.statusCode).toBe(403);

      const noAuthParse = await parseImage(
        { image: { base64: PNG_BASE64, contentType: PNG_CONTENT_TYPE } },
        '',
      );
      expect(noAuthParse.statusCode).toBe(401);

      const noAuthConfig = await app.inject({ method: 'GET', url: '/api/ai/config' });
      expect(noAuthConfig.statusCode).toBe(401);
    });
  });
});
