import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenaiLlmAdapter } from './openai-llm.adapter';

const CONFIG = { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-test', model: 'qwen-vl-max' };

function okResponse(overrides: Record<string, unknown> = {}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: 'qwen-vl-max',
      choices: [{ message: { content: '结构化结果' } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
      ...overrides,
    }),
  } as Response;
}

function failResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    text: async () => body,
  } as Response;
}

describe('OpenaiLlmAdapter：OpenAI 兼容驱动（原生 fetch）', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('构造缺配置 → 抛错（fail-fast）', () => {
    expect(() => new OpenaiLlmAdapter({ baseUrl: '', apiKey: 'k', model: 'm' })).toThrow(/配置不完整/);
    expect(() => new OpenaiLlmAdapter({ baseUrl: 'https://x', apiKey: '', model: 'm' })).toThrow(/配置不完整/);
  });

  it('text 消息 → 请求体原样透传 + Bearer 头 + 正确 URL', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const llm = new OpenaiLlmAdapter(CONFIG);
    await llm.chat({
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('qwen-vl-max');
    expect(body.messages).toEqual([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ]);
  });

  it('多模态 parts → OpenAI image_url 协议形状', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const llm = new OpenaiLlmAdapter(CONFIG);
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    await llm.chat({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '请解析' },
            { type: 'image_url', imageUrl: dataUrl },
          ],
        },
      ],
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: '请解析' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ]);
  });

  it('响应解析：content + 真实 usage（model 取响应字段）', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const llm = new OpenaiLlmAdapter(CONFIG);
    const res = await llm.chat({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.content).toBe('结构化结果');
    expect(res.usage).toEqual({ model: 'qwen-vl-max', inputTokens: 12, outputTokens: 3 });
  });

  it('响应缺 model → 回退配置 model', async () => {
    fetchMock.mockResolvedValue(okResponse({ model: undefined }));
    const llm = new OpenaiLlmAdapter(CONFIG);
    const res = await llm.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.usage.model).toBe('qwen-vl-max');
  });

  it('content null / 数组容错', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ choices: [{ message: { content: null } }] }));
    fetchMock.mockResolvedValueOnce(
      okResponse({ choices: [{ message: { content: [{ type: 'text', text: '段一' }, { type: 'text', text: '段二' }] } }] }),
    );
    const llm = new OpenaiLlmAdapter(CONFIG);
    expect((await llm.chat({ messages: [{ role: 'user', content: 'a' }] })).content).toBe('');
    expect((await llm.chat({ messages: [{ role: 'user', content: 'b' }] })).content).toBe('段一段二');
  });

  it('非 2xx → 抛错（status + body 摘要）', async () => {
    fetchMock.mockResolvedValue(failResponse(429, 'rate limit exceeded, please retry later'));
    const llm = new OpenaiLlmAdapter(CONFIG);
    await expect(llm.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/HTTP 429/);
    await expect(llm.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/rate limit/);
  });
});
