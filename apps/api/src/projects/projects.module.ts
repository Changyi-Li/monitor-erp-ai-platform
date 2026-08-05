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
})
export class ProjectsModule {}
