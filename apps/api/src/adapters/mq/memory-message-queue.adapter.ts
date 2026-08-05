import type { MessageQueuePort } from './message-queue.port';

type Handler = (message: unknown) => void | Promise<void>;

/**
 * 内存实现：进程内主题 → 订阅者集合，测试/开发默认。
 * publish 经 JSON 序列化往返（贴近真实 MQ 的跨进程语义，handler 收到的是拷贝）。
 */
export class MemoryMessageQueueAdapter implements MessageQueuePort {
  private readonly subscribers = new Map<string, Set<Handler>>();

  async publish(topic: string, message: unknown): Promise<void> {
    const roundTrip = JSON.parse(JSON.stringify(message)) as unknown;
    const handlers = this.subscribers.get(topic);
    if (!handlers) {
      return;
    }
    // 拷贝快照：publish 期间新增订阅不影响本轮投递
    for (const handler of [...handlers]) {
      await handler(roundTrip);
    }
  }

  async subscribe(
    topic: string,
    handler: Handler,
  ): Promise<() => void> {
    let handlers = this.subscribers.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.subscribers.set(topic, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }
}
