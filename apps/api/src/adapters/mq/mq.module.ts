import { Global, Module, type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MemoryMessageQueueAdapter } from './memory-message-queue.adapter';
import type { MessageQueuePort } from './message-queue.port';

export const MQ = Symbol('MQ');

/** 消息队列适配工厂：切换实现 = 改 MQ_DRIVER 配置，业务代码零改动 */
@Global()
@Module({})
export class MqModule {
  static forRoot(): DynamicModule {
    return {
      module: MqModule,
      global: true,
      providers: [
        {
          provide: MQ,
          inject: [ConfigService],
          useFactory: (config: ConfigService): MessageQueuePort => {
            const driver = config.getOrThrow<string>('MQ_DRIVER');
            switch (driver) {
              case 'memory':
                return new MemoryMessageQueueAdapter();
              default:
                throw new Error(`未知消息队列驱动 MQ_DRIVER=${driver}`);
            }
          },
        },
      ],
      exports: [MQ],
    };
  }
}
