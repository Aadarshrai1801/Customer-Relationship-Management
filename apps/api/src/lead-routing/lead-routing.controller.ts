import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import {
  createRoutingRuleSchema,
  updateAvailabilitySchema,
  updateRoutingRuleSchema,
  type CreateRoutingRuleInput,
  type UpdateAvailabilityInput,
  type UpdateRoutingRuleInput,
} from './lead-routing.schemas';
import { LeadRoutingService } from './lead-routing.service';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('lead-routing')
export class LeadRoutingController {
  constructor(@Inject(LeadRoutingService) private readonly routing: LeadRoutingService) {}

  @RequireScopes('lead_routing:manage')
  @Post('rules')
  async createRule(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createRoutingRuleSchema)) body: unknown,
  ): Promise<unknown> {
    return this.routing.createRule(authOf(req), body as CreateRoutingRuleInput);
  }

  @RequireScopes('lead_routing:manage')
  @Get('rules')
  async listRules(@Req() req: Request): Promise<unknown> {
    return this.routing.listRules(authOf(req));
  }

  @RequireScopes('lead_routing:manage')
  @Get('rules/:id')
  async getRule(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.routing.getRule(authOf(req), id);
  }

  @RequireScopes('lead_routing:manage')
  @Patch('rules/:id')
  async updateRule(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateRoutingRuleSchema)) body: unknown,
  ): Promise<unknown> {
    return this.routing.updateRule(authOf(req), id, body as UpdateRoutingRuleInput);
  }

  @RequireScopes('lead_routing:manage')
  @Delete('rules/:id')
  async deleteRule(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.routing.deleteRule(authOf(req), id);
  }

  @RequireScopes('leads:read')
  @Get('availability')
  async getMyAvailability(@Req() req: Request): Promise<unknown> {
    return this.routing.getAvailability(authOf(req));
  }

  @RequireScopes('leads:read')
  @Patch('availability')
  async updateMyAvailability(
    @Req() req: Request,
    @Body(new ZodValidationPipe(updateAvailabilitySchema)) body: unknown,
  ): Promise<unknown> {
    return this.routing.setAvailability(authOf(req), body as UpdateAvailabilityInput);
  }

  @RequireScopes('lead_routing:manage')
  @Get('availability/:userId')
  async getUserAvailability(
    @Req() req: Request,
    @Param('userId') userId: string,
  ): Promise<unknown> {
    return this.routing.getAvailability(authOf(req), userId);
  }

  @RequireScopes('lead_routing:manage')
  @Patch('availability/:userId')
  async updateUserAvailability(
    @Req() req: Request,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(updateAvailabilitySchema)) body: unknown,
  ): Promise<unknown> {
    return this.routing.setAvailability(authOf(req), body as UpdateAvailabilityInput, userId);
  }
}
