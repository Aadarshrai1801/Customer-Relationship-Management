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
import { Public } from '../common/public.decorator';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import { SchedulingService } from './scheduling.service';
import {
  bookSlotSchema,
  createLinkSchema,
  updateLinkSchema,
  type BookSlotInput,
  type CreateLinkInput,
  type UpdateLinkInput,
} from './scheduling.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('booking-links')
export class SchedulingController {
  constructor(@Inject(SchedulingService) private readonly scheduling: SchedulingService) {}

  @RequireScopes('activities:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createLinkSchema)) body: unknown,
  ): Promise<unknown> {
    return this.scheduling.createLink(authOf(req), body as CreateLinkInput);
  }

  @RequireScopes('activities:read')
  @Get()
  async list(@Req() req: Request): Promise<unknown> {
    return this.scheduling.listLinks(authOf(req));
  }

  @RequireScopes('activities:manage')
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateLinkSchema)) body: unknown,
  ): Promise<unknown> {
    return this.scheduling.updateLink(authOf(req), id, body as UpdateLinkInput);
  }

  @RequireScopes('activities:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.scheduling.removeLink(authOf(req), id);
  }
}

@Controller('book')
export class BookingPublicController {
  constructor(@Inject(SchedulingService) private readonly scheduling: SchedulingService) {}

  @Public()
  @Get(':slug/availability')
  async availability(@Param('slug') slug: string): Promise<unknown> {
    const orgId = await this.scheduling.resolveOrgForSlug(slug);
    return this.scheduling.availability(slug, orgId);
  }

  @Public()
  @Post(':slug')
  async book(
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(bookSlotSchema)) body: unknown,
  ): Promise<unknown> {
    const orgId = await this.scheduling.resolveOrgForSlug(slug);
    return this.scheduling.book(slug, orgId, body as BookSlotInput);
  }
}
