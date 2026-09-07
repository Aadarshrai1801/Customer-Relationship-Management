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
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import { ReportsService } from './reports.service';
import { DashboardsService } from './dashboards.service';
import {
  activityReportQuerySchema,
  conversionReportQuerySchema,
  forecastReportQuerySchema,
  pipelineReportQuerySchema,
  type ActivityReportQuery,
  type ConversionReportQuery,
  type ForecastReportQuery,
  type PipelineReportQuery,
} from './reports.schemas';
import {
  createDashboardSchema,
  updateDashboardSchema,
  type CreateDashboardInput,
  type UpdateDashboardInput,
} from './dashboards.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

const dashboardListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

@Controller('reports')
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  @RequireScopes('reports:read')
  @Get('forecast')
  async forecast(
    @Req() req: Request,
    @Query(new ZodValidationPipe(forecastReportQuerySchema)) query: unknown,
  ): Promise<unknown> {
    return this.reports.forecast(authOf(req), query as ForecastReportQuery);
  }

  @RequireScopes('reports:read')
  @Get('pipeline')
  async pipeline(
    @Req() req: Request,
    @Query(new ZodValidationPipe(pipelineReportQuerySchema)) query: unknown,
  ): Promise<unknown> {
    return this.reports.pipeline(authOf(req), query as PipelineReportQuery);
  }

  @RequireScopes('reports:read')
  @Get('activity')
  async activity(
    @Req() req: Request,
    @Query(new ZodValidationPipe(activityReportQuerySchema)) query: unknown,
  ): Promise<unknown> {
    return this.reports.activity(authOf(req), query as ActivityReportQuery);
  }

  @RequireScopes('reports:read')
  @Get('conversion')
  async conversion(
    @Req() req: Request,
    @Query(new ZodValidationPipe(conversionReportQuerySchema)) query: unknown,
  ): Promise<unknown> {
    return this.reports.conversion(authOf(req), query as ConversionReportQuery);
  }
}

@Controller('dashboards')
export class DashboardsController {
  constructor(@Inject(DashboardsService) private readonly dashboards: DashboardsService) {}

  @RequireScopes('dashboards:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createDashboardSchema)) body: unknown,
  ): Promise<unknown> {
    return this.dashboards.create(authOf(req), body as CreateDashboardInput);
  }

  @RequireScopes('dashboards:read')
  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(dashboardListQuerySchema)) query: unknown,
  ): Promise<unknown> {
    return this.dashboards.list(authOf(req), query as { limit?: number; cursor?: string });
  }

  @RequireScopes('dashboards:read')
  @Get(':id')
  async getById(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.dashboards.getById(authOf(req), id);
  }

  @RequireScopes('dashboards:manage')
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateDashboardSchema)) body: unknown,
  ): Promise<unknown> {
    return this.dashboards.update(authOf(req), id, body as UpdateDashboardInput);
  }

  @RequireScopes('dashboards:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.dashboards.remove(authOf(req), id);
  }
}
