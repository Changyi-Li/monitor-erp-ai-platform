import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { ImportSourceItem, ImportSourcePort } from './import-source.port';

/** 文件类拉取上限（同 kb 上传 6MB；超限条目丢弃并记日志） */
const MAX_FILE_BYTES = 6_000_000;
/** markdown 类正文上限（同契约 body ≤200_000） */
const MAX_BODY_CHARS = 200_000;

/** 外部清单格式 v1（HTTP GET 返回 JSON 数组） */
const ManifestItemSchema = z.object({
  sourceKey: z.string().trim().min(1).max(255),
  title: z.string().trim().min(1).max(255),
  category: z.enum(['manual', 'faq', 'best_practice']),
  format: z.enum(['markdown', 'html', 'pdf', 'word']),
  content: z.string().max(MAX_BODY_CHARS).optional(), // markdown/html 正文（或清单内联 base64）
  contentUrl: z.url().optional(), // pdf/word 拉取地址（或 markdown/html 正文地址）
  updatedAt: z.iso.datetime().optional(),
});
const ManifestSchema = z.array(ManifestItemSchema);

/**
 * HTTP 导入源适配器（issue #25）：GET IMPORT_FETCH_URL（可选 Bearer 凭证）→ zod 校验
 * 清单 → contentUrl 条目二次拉取（正文 ≤200k / 文件 ≤6MB，超限丢弃记日志）→
 * format 映射 docType。未配置 URL 时模块不启动（import-fetch.worker 判断）。
 */
@Injectable()
export class HttpImportSourceAdapter implements ImportSourcePort {
  private readonly logger = new Logger(HttpImportSourceAdapter.name);

  constructor(private readonly config: ConfigService) {}

  async fetchManifest(): Promise<ImportSourceItem[]> {
    const url = this.config.get<string>('IMPORT_FETCH_URL');
    if (!url) {
      return [];
    }
    const apiKey = this.config.get<string>('IMPORT_FETCH_API_KEY');
    const res = await fetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`拉取导入源失败：HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
    }
    const parsed = ManifestSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new Error(`导入源清单格式非法：${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }

    const items: ImportSourceItem[] = [];
    for (const raw of parsed.data) {
      const item = await this.resolveContent(raw);
      if (item) {
        items.push(item);
      }
    }
    return items;
  }

  /** 条目 → 结构化 item：content 内联 / contentUrl 二次拉取；超限或拉取失败 → 丢弃（null） */
  private async resolveContent(
    raw: z.infer<typeof ManifestItemSchema>,
  ): Promise<ImportSourceItem | null> {
    const base = {
      sourceKey: raw.sourceKey,
      title: raw.title,
      category: raw.category,
      updatedAt: raw.updatedAt,
    };

    if (raw.format === 'markdown' || raw.format === 'html') {
      // markdown/html 正文按 markdown 类存（HTML 渲染 escape-first，不解析）
      if (raw.content !== undefined) {
        return { ...base, docType: 'markdown', body: raw.content };
      }
      if (raw.contentUrl) {
        const body = await this.fetchText(raw.contentUrl);
        if (body === null) {
          return null; // 拉取失败/超限已记日志
        }
        return { ...base, docType: 'markdown', body };
      }
      this.logger.warn(`导入源条目 ${raw.sourceKey} 缺少 content 与 contentUrl，跳过`);
      return null;
    }

    // pdf/word → 文件类
    if (raw.content) {
      const buffer = Buffer.from(raw.content, 'base64');
      if (buffer.byteLength === 0 || buffer.byteLength > MAX_FILE_BYTES) {
        this.logger.warn(`导入源条目 ${raw.sourceKey} 文件超限或为空，跳过`);
        return null;
      }
      return {
        ...base,
        docType: 'file',
        base64: raw.content,
        fileName: `${raw.sourceKey.split('/').pop() ?? 'document'}.${raw.format === 'pdf' ? 'pdf' : 'docx'}`,
        contentType: raw.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      };
    }
    if (raw.contentUrl) {
      const result = await this.fetchFile(raw.contentUrl);
      if (!result) {
        return null;
      }
      const fileName = decodeURIComponent(raw.contentUrl.split('/').pop() ?? `document.${raw.format === 'pdf' ? 'pdf' : 'docx'}`);
      return {
        ...base,
        docType: 'file',
        base64: result.base64,
        fileName,
        contentType: result.contentType || (raw.format === 'pdf' ? 'application/pdf' : 'application/octet-stream'),
      };
    }
    this.logger.warn(`导入源条目 ${raw.sourceKey} 缺少 content 与 contentUrl，跳过`);
    return null;
  }

  /** 拉取文本正文（≤200k 字符；超限/失败 → null） */
  private async fetchText(url: string): Promise<string | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        this.logger.warn(`拉取正文失败 ${url}：HTTP ${res.status}`);
        return null;
      }
      const text = await res.text();
      if (text.length > MAX_BODY_CHARS) {
        this.logger.warn(`正文超限（${text.length} 字符 > ${MAX_BODY_CHARS}），丢弃 ${url}`);
        return null;
      }
      return text;
    } catch (err) {
      this.logger.warn(`拉取正文失败 ${url}：${String(err)}`);
      return null;
    }
  }

  /** 拉取文件（≤6MB；超限/失败 → null） */
  private async fetchFile(
    url: string,
  ): Promise<{ base64: string; contentType: string | null } | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        this.logger.warn(`拉取文件失败 ${url}：HTTP ${res.status}`);
        return null;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.byteLength === 0 || buffer.byteLength > MAX_FILE_BYTES) {
        this.logger.warn(`文件超限或为空（${buffer.byteLength} 字节），丢弃 ${url}`);
        return null;
      }
      return { base64: buffer.toString('base64'), contentType: res.headers.get('content-type') };
    } catch (err) {
      this.logger.warn(`拉取文件失败 ${url}：${String(err)}`);
      return null;
    }
  }
}
