import { Module } from '@nestjs/common';
import { KbController } from './kb.controller';
import { KbService } from './kb.service';

/**
 * 内部知识库（issue #19）：全局文档域 + 项目文档（issue #26 手册产物；projectId/tenantId
 * 挂靠，发布 scope 路由 'customer'）。StoragePort/AuditService/TenantContextService 均为
 * @Global 无需 import；KbService 导出供 ManualModule 注入。
 */
@Module({
  controllers: [KbController],
  providers: [KbService],
  exports: [KbService],
})
export class KbModule {}
