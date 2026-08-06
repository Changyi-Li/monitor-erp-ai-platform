import { Global, Module, type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MemoryDocumentIndexAdapter } from './memory-document-index.adapter';
import type { DocumentIndexPort } from './document-index.port';

export const IDX = Symbol('IDX');

/** 文档索引适配工厂：切换真实 RAG 平台 = 改 INDEX_DRIVER 配置，业务代码零改动 */
@Global()
@Module({})
export class IndexingModule {
  static forRoot(): DynamicModule {
    return {
      module: IndexingModule,
      global: true,
      providers: [
        {
          provide: IDX,
          inject: [ConfigService],
          useFactory: (config: ConfigService): DocumentIndexPort => {
            const driver = config.getOrThrow<string>('INDEX_DRIVER');
            switch (driver) {
              case 'memory':
                return new MemoryDocumentIndexAdapter();
              default:
                throw new Error(`未知文档索引驱动 INDEX_DRIVER=${driver}`);
            }
          },
        },
      ],
      exports: [IDX],
    };
  }
}
