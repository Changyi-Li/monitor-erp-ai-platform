import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

/** 平台内部 AI 能力（LLM / LLM_RUNTIME_CONFIG / DRIZZLE / AUDIT 均 @Global，无需 import） */
@Module({
  controllers: [AiController],
  providers: [AiService],
})
export class AiModule {}
