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
import { SequencesService } from './sequences.service';
import {
  createSequenceSchema,
  enrollContactSchema,
  updateSequenceSchema,
  type CreateSequenceInput,
  type UpdateSequenceInput,
} from './sequences.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('sequences')
export class SequencesController {
  constructor(@Inject(SequencesService) private readonly sequences: SequencesService) {}

  @RequireScopes('activities:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createSequenceSchema)) body: unknown,
  ): Promise<unknown> {
    return this.sequences.create(authOf(req), body as CreateSequenceInput);
  }

  @RequireScopes('activities:read')
  @Get()
  async list(@Req() req: Request): Promise<unknown> {
    return this.sequences.list(authOf(req));
  }

  @RequireScopes('activities:read')
  @Get(':id')
  async getById(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.sequences.getById(authOf(req), id);
  }

  @RequireScopes('activities:manage')
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateSequenceSchema)) body: unknown,
  ): Promise<unknown> {
    return this.sequences.update(authOf(req), id, body as UpdateSequenceInput);
  }

  @RequireScopes('activities:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.sequences.remove(authOf(req), id);
  }

  @RequireScopes('activities:manage')
  @Post(':id/enrollments')
  async enroll(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(enrollContactSchema)) body: unknown,
  ): Promise<unknown> {
    return this.sequences.enroll(authOf(req), id, (body as { contactId: string }).contactId);
  }

  @RequireScopes('activities:read')
  @Get(':id/enrollments')
  async enrollments(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.sequences.listEnrollments(authOf(req), id);
  }

  @RequireScopes('activities:manage')
  @Post('enrollments/:enrollmentId/pause')
  async pause(@Req() req: Request, @Param('enrollmentId') enrollmentId: string): Promise<unknown> {
    return this.sequences.pauseEnrollment(authOf(req), enrollmentId);
  }

  @RequireScopes('activities:manage')
  @Post('enrollments/:enrollmentId/resume')
  async resume(@Req() req: Request, @Param('enrollmentId') enrollmentId: string): Promise<unknown> {
    return this.sequences.resumeEnrollment(authOf(req), enrollmentId);
  }

  @RequireScopes('activities:manage')
  @Post('enrollments/:enrollmentId/cancel')
  async cancel(@Req() req: Request, @Param('enrollmentId') enrollmentId: string): Promise<unknown> {
    return this.sequences.cancelEnrollment(authOf(req), enrollmentId);
  }

  @RequireScopes('activities:manage')
  @Post('due-scan')
  async dueScan(@Req() req: Request): Promise<unknown> {
    void authOf(req);
    return this.sequences.runDue();
  }
}
