import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  // AuthModule 导出 PasswordService（邀请占位密码）
  imports: [AuthModule],
  controllers: [ProjectsController, MembersController],
  providers: [ProjectsService, MembersService],
  // 导出 MembersService：IssuesModule 等依赖项目成员角色解析
  exports: [MembersService],
})
export class ProjectsModule {}
