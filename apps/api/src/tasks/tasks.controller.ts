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
import { TasksService } from './tasks.service';
import { CalendarSyncService } from './calendar-sync.service';
import { syncEventSchema, type SyncEventInput } from './calendar-sync.schemas';
import {
  createActivitySchema,
  createTaskSchema,
  listActivitiesQuerySchema,
  listTasksQuerySchema,
  updateActivitySchema,
  updateTaskSchema,
  type CreateActivityInput,
  type CreateTaskInput,
  type ListActivitiesQuery,
  type ListTasksQuery,
  type UpdateActivityInput,
  type UpdateTaskInput,
} from './tasks.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('tasks')
export class TasksController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @RequireScopes('tasks:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createTaskSchema)) body: unknown,
  ): Promise<unknown> {
    return this.tasks.create(authOf(req), body as CreateTaskInput);
  }

  @RequireScopes('tasks:read')
  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(listTasksQuerySchema)) query: unknown,
  ): Promise<unknown> {
    return this.tasks.list(authOf(req), query as ListTasksQuery);
  }

  @RequireScopes('tasks:read')
  @Get(':id')
  async getById(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.tasks.getById(authOf(req), id);
  }

  @RequireScopes('tasks:manage')
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTaskSchema)) body: unknown,
  ): Promise<unknown> {
    return this.tasks.update(authOf(req), id, body as UpdateTaskInput);
  }

  @RequireScopes('tasks:manage')
  @Post('reminders/dispatch')
  async dispatchReminders(@Req() req: Request): Promise<unknown> {
    return this.tasks.dispatchReminderDigests(authOf(req));
  }

  @RequireScopes('tasks:manage')
  @Post(':id/complete')
  async complete(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.tasks.complete(authOf(req), id);
  }

  @RequireScopes('tasks:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.tasks.remove(authOf(req), id);
  }
}

@Controller('activities')
export class ActivitiesController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @RequireScopes('activities:manage')
  @Post()
  async log(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createActivitySchema)) body: unknown,
  ): Promise<unknown> {
    return this.tasks.logActivity(authOf(req), body as CreateActivityInput);
  }

  @RequireScopes('activities:read')
  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(listActivitiesQuerySchema)) query: unknown,
  ): Promise<unknown> {
    return this.tasks.listActivities(authOf(req), query as ListActivitiesQuery);
  }

  @RequireScopes('activities:read')
  @Get(':id')
  async getById(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.tasks.getActivityById(authOf(req), id);
  }

  @RequireScopes('activities:manage')
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateActivitySchema)) body: unknown,
  ): Promise<unknown> {
    return this.tasks.updateActivity(authOf(req), id, body as UpdateActivityInput);
  }
}

@Controller('calendar-sync')
export class CalendarSyncController {
  constructor(@Inject(CalendarSyncService) private readonly sync: CalendarSyncService) {}

  @RequireScopes('activities:manage')
  @Post('events')
  async syncEvent(
    @Req() req: Request,
    @Body(new ZodValidationPipe(syncEventSchema)) body: unknown,
  ): Promise<unknown> {
    return this.sync.syncEvent(authOf(req), body as SyncEventInput);
  }
}
