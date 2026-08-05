import { Global, Module, type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MemoryStorageAdapter } from './memory-storage.adapter';
import type { StoragePort } from './storage.port';

export const STORAGE = Symbol('STORAGE');

/** 存储适配工厂：切换实现 = 改 STORAGE_DRIVER 配置，业务代码零改动 */
@Global()
@Module({})
export class StorageModule {
  static forRoot(): DynamicModule {
    return {
      module: StorageModule,
      global: true,
      providers: [
        {
          provide: STORAGE,
          inject: [ConfigService],
          useFactory: (config: ConfigService): StoragePort => {
            const driver = config.getOrThrow<string>('STORAGE_DRIVER');
            switch (driver) {
              case 'memory':
                return new MemoryStorageAdapter();
              default:
                throw new Error(`未知存储驱动 STORAGE_DRIVER=${driver}`);
            }
          },
        },
      ],
      exports: [STORAGE],
    };
  }
}
