/**
 * 消息队列适配端口（供应商可替换，spec 平台无关约束）。
 * 发布订阅模型的最小面；事务消息/顺序消费等 RocketMQ 特性按需再演进。
 */
export interface MessageQueuePort {
  /** 发布消息（对象经 JSON 序列化边界，模拟跨进程语义） */
  publish(topic: string, message: unknown): Promise<void>;
  /** 订阅主题，返回退订函数 */
  subscribe(
    topic: string,
    handler: (message: unknown) => void | Promise<void>,
  ): Promise<() => void>;
}
