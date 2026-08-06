import { Module } from '@nestjs/common';
import { KbController } from './kb.controller';
import { KbService } from './kb.service';

/**
 * 内部知识库（issue #19）：全局文档域（无项目/租户归属——StoragePort/AuditService/
 * TenantContextService 均为 @Global，无需 import）。
 */
@Module({
  controllers: [KbController],
  providers: [KbService],
})
export class KbModule {}
