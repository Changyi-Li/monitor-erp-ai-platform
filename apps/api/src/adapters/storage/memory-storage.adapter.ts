import type { StoragePort } from './storage.port';

/** 内存实现：进程内 Map，测试/开发默认。生产切 S3 实现只改 STORAGE_DRIVER 配置。 */
export class MemoryStorageAdapter implements StoragePort {
  private readonly store = new Map<string, { body: Buffer; contentType?: string }>();

  async put(
    key: string,
    body: Buffer,
    options?: { contentType?: string },
  ): Promise<string> {
    this.store.set(key, { body, contentType: options?.contentType });
    return key;
  }

  async get(key: string): Promise<Buffer | null> {
    return this.store.get(key)?.body ?? null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
