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
import { WorkflowsService } from './workflows.service';
import { WorkflowEngine } from './workflow-engine.service';
import {
  createWorkflowSchema,
  listRunsQuerySchema,
  listWorkflowsQuerySchema,
  updateWorkflowSchema,
  type CreateWorkflowInput,
  type UpdateWorkflowInput,
} from './workflows.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('workflows')
export class WorkflowsController {
  constructor(
    @Inject(WorkflowsService) private readonly workflows: WorkflowsService,
    @Inject(WorkflowEngine) private readonly engine: WorkflowEngine,
  ) {}

  @RequireScopes('workflows:manage')
  @Post('due-scan')
  async dueScan(@Req() req: Request): Promise<unknown> {
    void authOf(req);
    return this.engine.evaluateDue();
  }

  @RequireScopes('workflows:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createWorkflowSchema)) body: unknown,
  ): Promise<unknown> {
    return this.workflows.create(authOf(req), body as CreateWorkflowInput);
  }

  @RequireScopes('workflows:read')
  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(listWorkflowsQuerySchema)) query: unknown,
  ): Promise<unknown> {
    return this.workflows.list(authOf(req), query as { limit?: number; cursor?: string });
  }

  @RequireScopes('workflows:read')
  @Get(':id')
  async getById(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.workflows.getById(authOf(req), id);
  }

  @RequireScopes('workflows:manage')
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateWorkflowSchema)) body: unknown,
  ): Promise<unknown> {
    return this.workflows.update(authOf(req), id, body as UpdateWorkflowInput);
  }

  @RequireScopes('workflows:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.workflows.remove(authOf(req), id);
  }

  @RequireScopes('workflows:read')
  @Get(':id/runs')
  async runs(
    @Req() req: Request,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(listRunsQuerySchema)) query: unknown,
  ): Promise<unknown> {
    const { status, limit, cursor } = query as {
      status?: 'success' | 'failed' | 'skipped';
      limit?: number;
      cursor?: string;
    };
    return this.workflows.listRuns(authOf(req), id, { status, limit, cursor });
  }
}
