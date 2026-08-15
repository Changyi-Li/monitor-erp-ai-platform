import { Injectable } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';

const DEFAULT_HASH_ROUNDS = 12;

/**
 * bcryptjs：纯 JS 零原生编译，Windows 无 node-gyp 坑。
 * 轮数可经 PASSWORD_HASH_ROUNDS 覆盖（4-15）——e2e/单测环境设 4（≈50ms/次，
 * .env.test 已配置），生产默认 12（≈2-3s/次）。哈希强度只影响暴力破解成本，
 * 轮数下限 4 保证测试仍走真实 bcrypt 路径（非 mock）。
 */
@Injectable()
export class PasswordService {
  private readonly rounds: number;

  constructor() {
    const raw = process.env.PASSWORD_HASH_ROUNDS;
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    this.rounds =
      Number.isInteger(parsed) && parsed >= 4 && parsed <= 15
        ? parsed
        : DEFAULT_HASH_ROUNDS;
  }

  hash(plain: string): Promise<string> {
    return hash(plain, this.rounds);
  }

  verify(plain: string, hashed: string): Promise<boolean> {
    return compare(plain, hashed);
  }
}
