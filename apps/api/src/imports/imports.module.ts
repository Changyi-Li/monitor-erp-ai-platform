import { Module } from '@nestjs/common';
import { HttpImportSourceAdapter } from './http-import-source.adapter';
import { ImportAuthGuard } from './import-auth.guard';
import { ImportFetchWorker } from './import-fetch.worker';
import { ImportWorker } from './import.worker';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { IMPORT_SOURCE } from './import-source.port';

/**
 * Online help 导入（issue #25，spec §4.4）。依赖全部 @Global（Drizzle/Storage/Audit/
 * RagSync/MQ/Jwt），无需 import。
 */
@Module({
  controllers: [ImportsController],
  providers: [
    ImportsService,
    ImportWorker,
    ImportFetchWorker,
    ImportAuthGuard,
    { provide: IMPORT_SOURCE, useClass: HttpImportSourceAdapter },
  ],
  exports: [ImportsService],
})
export class ImportsModule {}
