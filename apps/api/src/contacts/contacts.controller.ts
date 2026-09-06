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
import { ContactsService } from './contacts.service';
import {
  createContactSchema,
  listContactsQuerySchema,
  updateContactSchema,
  type CreateContactInput,
  type ListContactsQuery,
  type UpdateContactInput,
} from './contacts.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('contacts')
export class ContactsController {
  constructor(@Inject(ContactsService) private readonly contacts: ContactsService) {}

  @RequireScopes('contacts:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createContactSchema)) body: unknown,
  ): Promise<unknown> {
    return this.contacts.create(authOf(req), body as CreateContactInput);
  }

  @RequireScopes('contacts:read')
  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(listContactsQuerySchema)) query: unknown,
  ): Promise<unknown> {
    return this.contacts.list(authOf(req), query as ListContactsQuery);
  }

  @RequireScopes('contacts:read')
  @Get(':id')
  async getById(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.contacts.getById(authOf(req), id);
  }

  @RequireScopes('contacts:manage')
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateContactSchema)) body: unknown,
  ): Promise<unknown> {
    return this.contacts.update(authOf(req), id, body as UpdateContactInput);
  }

  @RequireScopes('contacts:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.contacts.remove(authOf(req), id);
  }
}
