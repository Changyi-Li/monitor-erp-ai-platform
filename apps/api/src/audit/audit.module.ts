import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/** @Global：任何模块可注入 AuditService 记录审计 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
