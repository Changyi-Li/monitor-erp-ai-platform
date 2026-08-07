import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { HttpImportSourceAdapter } from './http-import-source.adapter';

/**
 * HTTP 导入源适配器单测（issue #25 定时拉取）：
 * vi.stubGlobal('fetch') 模拟清单/正文/文件拉取——测试不打真实网络。
 */
const MD = '# 外部文档\n正文内容';

function stubFetch(routes: Record<string, Response | ((url: string) => Response | Promise<Response>)>) {
  const fn = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (u.startsWith(prefix)) {
        return typeof handler === 'function' ? handler(u) : handler;
      }
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeAdapter(env: Record<string, string | undefined>): HttpImportSourceAdapter {
  return new HttpImportSourceAdapter({
    get: (key: string) => env[key],
  } as unknown as ConfigService);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpImportSourceAdapter：清单拉取（issue #25 定时同步）', () => {
  it('未配置 IMPORT_FETCH_URL → 空清单（worker 不启动场景）', async () => {
    const adapter = makeAdapter({});
    await expect(adapter.fetchManifest()).resolves.toEqual([]);
  });

  it('清单校验：非法枚举/缺字段 → 抛错带 issues（fail-fast，不静默吞）', async () => {
    stubFetch({
      'https://help.local/manifest': jsonResponse([
        { sourceKey: 'a', title: 'A', category: 'invalid', format: 'markdown', content: MD },
      ]),
    });
    const adapter = makeAdapter({ IMPORT_FETCH_URL: 'https://help.local/manifest' });
    await expect(adapter.fetchManifest()).rejects.toThrow('导入源清单格式非法');

    stubFetch({
      'https://help.local/manifest': jsonResponse([
        { title: 'no-source-key', format: 'markdown', content: MD },
      ]),
    });
    await expect(adapter.fetchManifest()).rejects.toThrow('导入源清单格式非法');
  });

  it('清单拉取失败（HTTP 500）→ 抛错', async () => {
    stubFetch({ 'https://help.local/manifest': new Response('boom', { status: 500 }) });
    const adapter = makeAdapter({ IMPORT_FETCH_URL: 'https://help.local/manifest' });
    await expect(adapter.fetchManifest()).rejects.toThrow(/HTTP 500/);
  });

  it('markdown 内联 content → docType markdown（body 原样）', async () => {
    stubFetch({
      'https://help.local/manifest': jsonResponse([
        { sourceKey: 'docs/order', title: '订单流程', category: 'manual', format: 'markdown', content: MD },
      ]),
    });
    const adapter = makeAdapter({ IMPORT_FETCH_URL: 'https://help.local/manifest' });
    await expect(adapter.fetchManifest()).resolves.toEqual([
      {
        sourceKey: 'docs/order',
        title: '订单流程',
        category: 'manual',
        docType: 'markdown',
        body: MD,
      },
    ]);
  });

  it('html 格式 → 按 markdown 类存（渲染 escape-first，不解析）', async () => {
    stubFetch({
      'https://help.local/manifest': jsonResponse([
        { sourceKey: 'h', title: 'H', category: 'faq', format: 'html', content: '<p>hi</p>' },
      ]),
    });
    const adapter = makeAdapter({ IMPORT_FETCH_URL: 'https://help.local/manifest' });
    const items = await adapter.fetchManifest();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ docType: 'markdown', body: '<p>hi</p>' });
  });

  it('markdown contentUrl → 二次拉取正文（≤200k 通过）', async () => {
    stubFetch({
      'https://help.local/manifest': jsonResponse([
        { sourceKey: 'u', title: 'U', category: 'best_practice', format: 'markdown', contentUrl: 'https://help.local/docs/u.md' },
      ]),
      'https://help.local/docs/u.md': new Response(MD),
    });
    const adapter = makeAdapter({ IMPORT_FETCH_URL: 'https://help.local/manifest' });
    const items = await adapter.fetchManifest();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ docType: 'markdown', body: MD });
  });

  it('contentUrl 正文超限 → 丢弃该条目（其余条目保留）', async () => {
    const huge = 'x'.repeat(200_001);
    stubFetch({
      'https://help.local/manifest': jsonResponse([
        { sourceKey: 'big', title: 'B', category: 'manual', format: 'markdown', contentUrl: 'https://help.local/big.md' },
        { sourceKey: 'ok', title: 'O', category: 'manual', format: 'markdown', content: MD },
      ]),
      'https://help.local/big.md': new Response(huge),
    });
    const adapter = makeAdapter({ IMPORT_FETCH_URL: 'https://help.local/manifest' });
    const items = await adapter.fetchManifest();
    expect(items).toHaveLength(1);
    expect(items[0].sourceKey).toBe('ok');
  });

  it('pdf/word → docType file（content 内联 base64，文件名/类型按 format 派生）', async () => {
    const pdfBase64 = Buffer.from('%PDF-1.4 fake').toString('base64');
    stubFetch({
      'https://help.local/manifest': jsonResponse([
        { sourceKey: 'guides/flow', title: 'F', category: 'manual', format: 'pdf', content: pdfBase64 },
        { sourceKey: 'guides/word', title: 'W', category: 'faq', format: 'word', content: pdfBase64 },
      ]),
    });
    const adapter = makeAdapter({ IMPORT_FETCH_URL: 'https://help.local/manifest' });
    const items = await adapter.fetchManifest();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      docType: 'file',
      base64: pdfBase64,
      fileName: 'flow.pdf',
      contentType: 'application/pdf',
    });
    expect(items[1]).toMatchObject({
      docType: 'file',
      fileName: 'word.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  });

  it('pdf contentUrl → 二次拉取文件 base64 + 响应头 contentType + URL 末段文件名', async () => {
    const raw = Buffer.from('fake pdf bytes');
    stubFetch({
      'https://help.local/manifest': jsonResponse([
        { sourceKey: 'p', title: 'P', category: 'manual', format: 'pdf', contentUrl: 'https://help.local/files/manual%20v2.pdf' },
      ]),
      'https://help.local/files/manual%20v2.pdf': new Response(raw, {
        headers: { 'Content-Type': 'application/pdf' },
      }),
    });
    const adapter = makeAdapter({ IMPORT_FETCH_URL: 'https://help.local/manifest' });
    const items = await adapter.fetchManifest();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      docType: 'file',
      base64: raw.toString('base64'),
      fileName: 'manual v2.pdf',
      contentType: 'application/pdf',
    });
  });

  it('文件类超限/为空 → 丢弃（不炸整次拉取）', async () => {
    const big = Buffer.alloc(6_000_001, 1);
    stubFetch({
      'https://help.local/manifest': jsonResponse([
        { sourceKey: 'too-big', title: 'T', category: 'manual', format: 'pdf', contentUrl: 'https://help.local/big.pdf' },
      ]),
      'https://help.local/big.pdf': new Response(big),
    });
    const adapter = makeAdapter({ IMPORT_FETCH_URL: 'https://help.local/manifest' });
    await expect(adapter.fetchManifest()).resolves.toEqual([]);
  });

  it('条目缺 content 且缺 contentUrl → 丢弃', async () => {
    stubFetch({
      'https://help.local/manifest': jsonResponse([
        { sourceKey: 'empty', title: 'E', category: 'manual', format: 'markdown' },
      ]),
    });
    const adapter = makeAdapter({ IMPORT_FETCH_URL: 'https://help.local/manifest' });
    await expect(adapter.fetchManifest()).resolves.toEqual([]);
  });

  it('配置 IMPORT_FETCH_API_KEY → 拉清单带 Bearer 头', async () => {
    const fn = stubFetch({
      'https://help.local/manifest': jsonResponse([{ sourceKey: 'k', title: 'K', category: 'manual', format: 'markdown', content: MD }]),
    });
    const adapter = makeAdapter({
      IMPORT_FETCH_URL: 'https://help.local/manifest',
      IMPORT_FETCH_API_KEY: 'secret-token',
    });
    await adapter.fetchManifest();
    const call = fn.mock.calls[0];
    const init = call?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe('Bearer secret-token');
  });
});
