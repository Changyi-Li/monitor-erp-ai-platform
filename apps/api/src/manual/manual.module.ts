import { Module } from '@nestjs/common';
import { KbModule } from '../kb/kb.module';
import { ProjectsModule } from '../projects/projects.module';
import { ManualController } from './manual.controller';
import { ManualService } from './manual.service';

/**
 * 操作手册自动生成（issue #26，spec §6）：LLM（@Global LlmModule）分章节生成 →
 * 逐章审校 → 组装 → 落项目 kb 草稿（KbService，KbModule exports）。
 * 项目准入复用 MembersService（resolveViewerRole，ProjectsModule exports）。
 */
@Module({
  imports: [KbModule, ProjectsModule],
  controllers: [ManualController],
  providers: [ManualService],
})
export class ManualModule {}
