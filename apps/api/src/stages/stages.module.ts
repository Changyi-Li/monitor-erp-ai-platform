import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { RisksController, StagesController } from './stages.controller';
import { StagesService } from './stages.service';

@Module({
  // ProjectsModule 导出 MembersService（项目成员角色解析，同 IssuesModule/BlueprintsModule）
  imports: [ProjectsModule],
  controllers: [StagesController, RisksController],
  providers: [StagesService],
})
export class StagesModule {}
