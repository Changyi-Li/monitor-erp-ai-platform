import { Global, Module } from '@nestjs/common';
import { RagSyncController } from './rag-sync.controller';
import { RagSyncService } from './rag-sync.service';
import { RagSyncWorker } from './rag-sync.worker';

/**
 * RAG 同步（issue #21，spec §4.3「发布即同步」）。
 * 依赖 DRIZZLE/RAW_DB/MQ/IDX/TenantContextService 均 @Global；
 * 本模块 @Global——kb/blueprints 的发布触发点需注入 RagSyncService 事务入队。
 */
@Global()
@Module({
  controllers: [RagSyncController],
  providers: [RagSyncService, RagSyncWorker],
  exports: [RagSyncService],
})
export class RagModule {}
