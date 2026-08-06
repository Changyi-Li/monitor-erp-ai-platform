import { Module } from '@nestjs/common';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';

/** AI 用量统计（issue #23）：DRIZZLE/AuditService 均 @Global，无需 imports */
@Module({
  controllers: [UsageController],
  providers: [UsageService],
})
export class UsageModule {}
