import { Injectable } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';

const HASH_ROUNDS = 12;

/** bcryptjs：纯 JS 零原生编译，Windows 无 node-gyp 坑 */
@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return hash(plain, HASH_ROUNDS);
  }

  verify(plain: string, hashed: string): Promise<boolean> {
    return compare(plain, hashed);
  }
}
