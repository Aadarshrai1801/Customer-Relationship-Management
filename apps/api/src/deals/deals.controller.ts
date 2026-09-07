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
import { CompetitorsService } from './competitors.service';
import { DealsService } from './deals.service';
import {
  createDealSchema,
  listDealsQuerySchema,
  addLineItemSchema,
  stalledDealsQuerySchema,
  updateDealSchema,
  type AddLineItemInput,
  type CreateDealInput,
  type ListDealsQuery,
  type StalledDealsQuery,
  type UpdateDealInput,
} from './deals.schemas';
import {
  forecastQuerySchema,
  transitionDealSchema,
  type ForecastQuery,
  type TransitionDealInput,
} from '../pipelines/pipelines.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('deals')
export class DealsController {
  constructor(@Inject(DealsService) private readonly deals: DealsService) {}

  @RequireScopes('deals:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createDealSchema)) body: unknown,
  ): Promise<unknown> {
    return this.deals.create(authOf(req), body as CreateDealInput);
  }

  @RequireScopes('deals:read')
  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(listDealsQuerySchema)) query: unknown,
  ): Promise<unknown> {
    return this.deals.list(authOf(req), query as ListDealsQuery);
  }

  @RequireScopes('deals:read')
  @Get('stalled')
  async stalled(
    @Req() req: Request,
    @Query(new ZodValidationPipe(stalledDealsQuerySchema)) query: unknown,
  ): Promise<unknown> {
    return this.deals.stalled(authOf(req), query as StalledDealsQuery);
  }

  @RequireScopes('deals:read')
  @Get(':id')
  async getById(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.deals.getById(authOf(req), id);
  }

  @RequireScopes('deals:manage')
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateDealSchema)) body: unknown,
  ): Promise<unknown> {
    return this.deals.update(authOf(req), id, body as UpdateDealInput);
  }

  @RequireScopes('deals:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.deals.remove(authOf(req), id);
  }

  @RequireScopes('deals:manage')
  @Post(':id/stage')
  async transition(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(transitionDealSchema)) body: unknown,
  ): Promise<unknown> {
    return this.deals.transitionStage(authOf(req), id, body as TransitionDealInput);
  }

  @RequireScopes('deals:read')
  @Get(':id/history')
  async history(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.deals.history(authOf(req), id);
  }

  @RequireScopes('deals:read')
  @Get(':id/line-items')
  async lineItems(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.deals.lineItems(authOf(req), id);
  }

  @RequireScopes('deals:manage')
  @Post(':id/line-items')
  async addLineItem(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(addLineItemSchema)) body: unknown,
  ): Promise<unknown> {
    return this.deals.addLineItem(authOf(req), id, body as AddLineItemInput);
  }

  @RequireScopes('deals:manage')
  @Delete(':id/line-items/:lineId')
  async removeLineItem(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
  ): Promise<unknown> {
    return this.deals.removeLineItem(authOf(req), id, lineId);
  }

  @RequireScopes('deals:read')
  @Get('forecast/by-pipeline')
  async forecast(
    @Req() req: Request,
    @Query(new ZodValidationPipe(forecastQuerySchema)) query: unknown,
  ): Promise<unknown> {
    const { pipelineId, ownerId, status } = query as ForecastQuery;
    return this.deals.forecast(authOf(req), pipelineId, { ownerId, status });
  }
}

const createCompetitorSchema = z
  .object({ name: z.string().trim().min(1, 'Name is required').max(100) })
  .strict();

@Controller('competitors')
export class CompetitorsController {
  constructor(@Inject(CompetitorsService) private readonly competitors: CompetitorsService) {}

  @RequireScopes('deals:read')
  @Get()
  async list(@Req() req: Request): Promise<unknown> {
    return this.competitors.list(authOf(req));
  }

  @RequireScopes('deals:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createCompetitorSchema)) body: unknown,
  ): Promise<unknown> {
    return this.competitors.create(authOf(req), (body as { name: string }).name);
  }

  @RequireScopes('deals:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.competitors.remove(authOf(req), id);
  }
}
