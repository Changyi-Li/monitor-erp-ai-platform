import { describe, expect, it } from 'vitest';
import { MemoryMessageQueueAdapter } from './memory-message-queue.adapter';

describe('MemoryMessageQueueAdapter', () => {
  it('publish 投递到订阅者；消息经 JSON 往返（拷贝）', async () => {
    const adapter = new MemoryMessageQueueAdapter();
    const received: unknown[] = [];
    await adapter.subscribe('topic-a', (m) => received.push(m));
    const original = { id: 1, nested: { ok: true } };
    await adapter.publish('topic-a', original);
    expect(received).toEqual([{ id: 1, nested: { ok: true } }]);
    // 拷贝语义：接收侧是新对象，改动不影响发布侧
    expect(received[0]).not.toBe(original);
  });

  it('多个订阅者都收到；无订阅者静默丢弃', async () => {
    const adapter = new MemoryMessageQueueAdapter();
    const got: number[] = [];
    await adapter.subscribe('t', () => got.push(1));
    await adapter.subscribe('t', () => got.push(2));
    await adapter.publish('t', 'x');
    expect(got.sort()).toEqual([1, 2]);
    await adapter.publish('no-subscriber', 'y'); // 不抛错
  });

  it('退订后不再收到；退订幂等', async () => {
    const adapter = new MemoryMessageQueueAdapter();
    const got: unknown[] = [];
    const unsubscribe = await adapter.subscribe('t', (m) => got.push(m));
    await adapter.publish('t', 'first');
    unsubscribe();
    unsubscribe(); // 幂等
    await adapter.publish('t', 'second');
    expect(got).toEqual(['first']);
  });

  it('订阅按主题隔离', async () => {
    const adapter = new MemoryMessageQueueAdapter();
    const got: unknown[] = [];
    await adapter.subscribe('a', (m) => got.push(['a', m]));
    await adapter.subscribe('b', (m) => got.push(['b', m]));
    await adapter.publish('b', 1);
    expect(got).toEqual([['b', 1]]);
  });
});
