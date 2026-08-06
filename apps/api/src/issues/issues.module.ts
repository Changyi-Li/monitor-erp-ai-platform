import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { IssuesController } from './issues.controller';
import { IssuesService } from './issues.service';

@Module({
  // ProjectsModule 导出 MembersService（项目成员角色解析）
  imports: [ProjectsModule],
  controllers: [IssuesController],
  providers: [IssuesService],
})
export class IssuesModule {}
