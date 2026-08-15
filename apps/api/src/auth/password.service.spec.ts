import { describe, expect, it } from 'vitest';
import { PasswordService } from './password.service';

// 单测走低轮数（≈50ms/次）：默认 12 轮纯 JS 哈希 ~2.5s/次，会把默认 5s 超时打满
// （e2e 环境由 .env.test 的 PASSWORD_HASH_ROUNDS=4 覆盖——见 .env.test.example 示例，
// 此处仅对本文件生效）
process.env.PASSWORD_HASH_ROUNDS = '4';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hash 与 verify 往返一致', async () => {
    const hashed = await service.hash('password123');
    expect(hashed).not.toBe('password123');
    expect(await service.verify('password123', hashed)).toBe(true);
  });

  it('错误密码 verify 失败', async () => {
    const hashed = await service.hash('password123');
    expect(await service.verify('wrong-password', hashed)).toBe(false);
  });
});
