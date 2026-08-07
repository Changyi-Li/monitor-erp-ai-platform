import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fingerprintFile, fingerprintMarkdown } from './fingerprint';

/** 与实现同构的参考实现（测试独立计算，防止「实现错、测试跟着错」） */
function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('fingerprint：内容指纹（issue #25 去重判定）', () => {
  it('确定性：同输入 → 同指纹', () => {
    expect(fingerprintMarkdown('# 标题\n正文')).toBe(fingerprintMarkdown('# 标题\n正文'));
    expect(fingerprintFile('aGVsbG8=')).toBe(fingerprintFile('aGVsbG8='));
  });

  it('内容敏感：任意字节差异 → 指纹不同', () => {
    expect(fingerprintMarkdown('hello')).not.toBe(fingerprintMarkdown('hellO'));
    expect(fingerprintMarkdown('hello')).not.toBe(fingerprintMarkdown('hello\n')); // 尾随换行
    expect(fingerprintFile(Buffer.from('ab').toString('base64'))).not.toBe(
      fingerprintFile(Buffer.from('ac').toString('base64')),
    );
  });

  it('markdown 指纹 = body UTF-8 字节的 sha256（多字节字符按 UTF-8 计）', () => {
    const body = '订单流程：先审后发 ✅';
    expect(fingerprintMarkdown(body)).toBe(sha256Hex(Buffer.from(body, 'utf8')));
  });

  it('file 指纹 = base64 解码后原始字节的 sha256（与编码形态无关）', () => {
    const raw = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x50]);
    const b64 = raw.toString('base64');
    expect(fingerprintFile(b64)).toBe(sha256Hex(raw));
    // 同一字节流的不同 base64 分段编码 → 同指纹
    const alt = Buffer.concat([raw.subarray(0, 2), raw.subarray(2)]).toString('base64');
    expect(fingerprintFile(alt)).toBe(fingerprintFile(b64));
  });

  it('markdown 与 file 在字节层面统一（同一字节流的两种输入形态 → 同指纹）', () => {
    // 同一份内容以「纯文本」或「base64 编码」两种形态推送，指纹一致 → 跨形态去重
    const body = '订单流程：先审后发';
    const asFile = Buffer.from(body, 'utf8').toString('base64');
    expect(fingerprintMarkdown(body)).toBe(fingerprintFile(asFile));
  });
});
