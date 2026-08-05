import { describe, expect, it } from 'vitest';
import { PasswordService } from './password.service';

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
