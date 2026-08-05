import { createHash } from 'node:crypto';

/**
 * 一次性/轮换 token 落库前统一 sha256（refresh token 与邀请 token 共用）。
 * 库里只存哈希，库被拖走也拿不到可用 token。
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
