import { Controller, Get, Param } from '@nestjs/common';
import {
  ProjectGetResponseSchema,
  ProjectsListResponseSchema,
  type ProjectGetResponse,
  type ProjectsListResponse,
} from '@monitor/contracts';
import { ZodResponse } from '../common/zod-response.interceptor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ProjectsService } from './projects.service';
import { z } from 'zod';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @ZodResponse(ProjectsListResponseSchema)
  list(): Promise<ProjectsListResponse> {
    return this.projects.list();
  }

  @Get(':id')
  @ZodResponse(ProjectGetResponseSchema)
  get(
    // 非法 uuid → 400，避免 22P02 → 500
    @Param('id', new ZodValidationPipe(z.uuid())) id: string,
  ): Promise<ProjectGetResponse> {
    return this.projects.getById(id);
  }
}
