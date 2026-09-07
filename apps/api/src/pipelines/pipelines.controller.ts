import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import { PipelinesService } from './pipelines.service';
import {
  createPipelineSchema,
  createStageSchema,
  deleteStageQuerySchema,
  updatePipelineSchema,
  updateStageSchema,
  type CreatePipelineInput,
  type CreateStageInput,
  type DeleteStageQuery,
  type UpdatePipelineInput,
  type UpdateStageInput,
} from './pipelines.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('pipelines')
export class PipelinesController {
  constructor(@Inject(PipelinesService) private readonly pipelines: PipelinesService) {}

  @RequireScopes('deals:read')
  @Get()
  async list(@Req() req: Request): Promise<unknown> {
    const auth = authOf(req);
    return this.pipelines.listPipelines(auth.org.id);
  }

  @RequireScopes('pipelines:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createPipelineSchema)) body: unknown,
  ): Promise<unknown> {
    const auth = authOf(req);
    return this.pipelines.createPipeline(auth.org.id, body as CreatePipelineInput, {
      id: auth.user.id,
      email: auth.user.email,
    });
  }

  @RequireScopes('pipelines:manage')
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updatePipelineSchema)) body: unknown,
  ): Promise<unknown> {
    const auth = authOf(req);
    return this.pipelines.updatePipeline(auth.org.id, id, body as UpdatePipelineInput, {
      id: auth.user.id,
      email: auth.user.email,
    });
  }

  @RequireScopes('pipelines:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    const auth = authOf(req);
    return this.pipelines.deletePipeline(auth.org.id, id, {
      id: auth.user.id,
      email: auth.user.email,
    });
  }

  @RequireScopes('pipelines:manage')
  @Post(':id/stages')
  async createStage(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createStageSchema)) body: unknown,
  ): Promise<unknown> {
    const auth = authOf(req);
    return this.pipelines.createStage(auth.org.id, id, body as CreateStageInput, {
      id: auth.user.id,
      email: auth.user.email,
    });
  }

  @RequireScopes('pipelines:manage')
  @Patch(':id/stages/:stageId')
  async updateStage(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('stageId') stageId: string,
    @Body(new ZodValidationPipe(updateStageSchema)) body: unknown,
  ): Promise<unknown> {
    const auth = authOf(req);
    return this.pipelines.updateStage(auth.org.id, id, stageId, body as UpdateStageInput, {
      id: auth.user.id,
      email: auth.user.email,
    });
  }

  @RequireScopes('pipelines:manage')
  @Delete(':id/stages/:stageId')
  async deleteStage(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('stageId') stageId: string,
    @Query(new ZodValidationPipe(deleteStageQuerySchema)) query: unknown,
  ): Promise<unknown> {
    const auth = authOf(req);
    const { migrateToStageId } = query as DeleteStageQuery;
    return this.pipelines.deleteStage(auth.org.id, id, stageId, migrateToStageId, {
      id: auth.user.id,
      email: auth.user.email,
    });
  }
}
