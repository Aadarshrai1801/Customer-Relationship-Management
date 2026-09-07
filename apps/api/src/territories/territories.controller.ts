import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import { TerritoriesService } from './territories.service';
import {
  createTerritorySchema,
  evaluateTerritorySchema,
  type CreateTerritoryInput,
} from './territories.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('territories')
export class TerritoriesController {
  constructor(@Inject(TerritoriesService) private readonly territories: TerritoriesService) {}

  @RequireScopes('contacts:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createTerritorySchema)) body: unknown,
  ): Promise<unknown> {
    return this.territories.create(authOf(req), body as CreateTerritoryInput);
  }

  @RequireScopes('contacts:read')
  @Get()
  async list(@Req() req: Request): Promise<unknown> {
    return this.territories.list(authOf(req));
  }

  @RequireScopes('contacts:read')
  @Get('evaluate')
  async evaluate(
    @Req() req: Request,
    @Query(new ZodValidationPipe(evaluateTerritorySchema)) query: unknown,
  ): Promise<unknown> {
    return this.territories.evaluate(
      authOf(req),
      query as { contactId?: string; leadId?: string },
    );
  }

  @RequireScopes('contacts:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.territories.remove(authOf(req), id);
  }
}
