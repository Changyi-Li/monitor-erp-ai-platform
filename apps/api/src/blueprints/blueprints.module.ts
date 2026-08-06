import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { BlueprintsController } from './blueprints.controller';
import { BlueprintsService } from './blueprints.service';

@Module({
  // ProjectsModule 导出 MembersService（项目成员角色解析，同 IssuesModule）
  imports: [ProjectsModule],
  controllers: [BlueprintsController],
  providers: [BlueprintsService],
})
export class BlueprintsModule {}
