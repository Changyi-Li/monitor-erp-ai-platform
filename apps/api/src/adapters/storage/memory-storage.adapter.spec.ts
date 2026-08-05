import { describe, expect, it } from 'vitest';
import { MemoryStorageAdapter } from './memory-storage.adapter';

describe('MemoryStorageAdapter', () => {
  it('put → get 往返；返回 key', async () => {
    const adapter = new MemoryStorageAdapter();
    const key = await adapter.put('a.txt', Buffer.from('hello'), {
      contentType: 'text/plain',
    });
    expect(key).toBe('a.txt');
    expect((await adapter.get('a.txt'))?.toString()).toBe('hello');
  });

  it('覆盖写；缺失 key 返回 null；delete 幂等', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.put('k', Buffer.from('v1'));
    await adapter.put('k', Buffer.from('v2'));
    expect((await adapter.get('k'))?.toString()).toBe('v2');
    expect(await adapter.get('missing')).toBeNull();
    await adapter.delete('k');
    expect(await adapter.get('k')).toBeNull();
    await adapter.delete('k'); // 幂等，不抛错
  });
});
