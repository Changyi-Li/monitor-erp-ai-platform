import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  ProjectCreateRequestSchema,
  ProjectCreateResponseSchema,
  ProjectGetResponseSchema,
  ProjectsListResponseSchema,
  type ProjectCreateRequest,
  type ProjectCreateResponse,
  type ProjectGetResponse,
  type ProjectsListResponse,
} from '@monitor/contracts';
import { CurrentUser, type AuthUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ProjectsService } from './projects.service';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @ZodResponse(ProjectsListResponseSchema)
  list(): Promise<ProjectsListResponse> {
    return this.projects.list();
  }

  /** 创建项目并归属客户（spec §2.1 修订：内部用户可建项目，超管专属的只有建客户） */
  @Roles('super_admin', 'internal')
  @Post()
  @ZodResponse(ProjectCreateResponseSchema)
  create(
    @CurrentUser() actor: AuthUser,
    @Body(new ZodValidationPipe(ProjectCreateRequestSchema)) body: ProjectCreateRequest,
  ): Promise<ProjectCreateResponse> {
    return this.projects.create(actor, body);
  }

  @Get(':id')
  @ZodResponse(ProjectGetResponseSchema)
  get(
    // 非法 uuid → 400，避免 22P02 → 500
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<ProjectGetResponse> {
    return this.projects.getById(id, actor);
  }
}
