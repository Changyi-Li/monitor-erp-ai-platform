import { createHash } from 'node:crypto';

/**
 * 内容指纹（issue #25 去重判定）：sha256(contentBytes) hex。
 * markdown → body UTF-8 字节；file → base64 解码后的原始字节。
 * 纯函数（spec Testing Decisions：幂等键/指纹等纯逻辑单测）。
 */
function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** markdown/html 类正文指纹 */
export function fingerprintMarkdown(body: string): string {
  return sha256Hex(Buffer.from(body, 'utf8'));
}

/** 文件类指纹（base64 解码后字节） */
export function fingerprintFile(base64: string): string {
  return sha256Hex(Buffer.from(base64, 'base64'));
}
