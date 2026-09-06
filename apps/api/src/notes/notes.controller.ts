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
import { NotesService } from './notes.service';
import {
  createNoteSchema,
  updateNoteSchema,
  type CreateNoteInput,
  type UpdateNoteInput,
} from './notes.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('contacts/:contactId/notes')
export class NotesController {
  constructor(@Inject(NotesService) private readonly notes: NotesService) {}

  @RequireScopes('contacts:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Param('contactId') contactId: string,
    @Body(new ZodValidationPipe(createNoteSchema)) body: unknown,
  ): Promise<unknown> {
    return this.notes.create(authOf(req), contactId, body as CreateNoteInput);
  }

  @RequireScopes('contacts:read')
  @Get()
  async list(@Req() req: Request, @Param('contactId') contactId: string): Promise<unknown> {
    return this.notes.list(authOf(req), contactId);
  }

  // Guard is read-level; the service enforces author-or-user-manager.
  @RequireScopes('contacts:read')
  @Patch(':noteId')
  async update(
    @Req() req: Request,
    @Param('contactId') contactId: string,
    @Param('noteId') noteId: string,
    @Body(new ZodValidationPipe(updateNoteSchema)) body: unknown,
  ): Promise<unknown> {
    return this.notes.update(authOf(req), contactId, noteId, body as UpdateNoteInput);
  }

  // Guard is read-level; the service enforces author-or-user-manager.
  @RequireScopes('contacts:read')
  @Delete(':noteId')
  async remove(
    @Req() req: Request,
    @Param('contactId') contactId: string,
    @Param('noteId') noteId: string,
  ): Promise<unknown> {
    return this.notes.remove(authOf(req), contactId, noteId);
  }
}
