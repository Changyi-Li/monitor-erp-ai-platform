import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { MinutesController } from './minutes.controller';
import { MinutesService } from './minutes.service';

@Module({
  // ProjectsModule 导出 MembersService（项目成员角色解析，同 IssuesModule/BlueprintsModule）
  imports: [ProjectsModule],
  controllers: [MinutesController],
  providers: [MinutesService],
})
export class MinutesModule {}
