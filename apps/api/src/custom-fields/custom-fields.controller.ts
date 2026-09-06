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
import { CustomFieldsService } from './custom-fields.service';
import {
  createFieldSchema,
  updateFieldSchema,
  type CreateFieldInput,
  type UpdateFieldInput,
} from './custom-fields.schemas';

const listQuerySchema = z.object({ entityType: z.enum(['contact', 'account', 'lead']) }).strict();

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('custom-fields')
export class CustomFieldsController {
  constructor(@Inject(CustomFieldsService) private readonly fields: CustomFieldsService) {}

  @RequireScopes('custom_fields:read')
  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(listQuerySchema)) query: unknown,
  ): Promise<unknown> {
    const { entityType } = query as { entityType: 'contact' | 'account' | 'lead' };
    return this.fields.list(authOf(req), entityType);
  }

  @RequireScopes('custom_fields:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createFieldSchema)) body: unknown,
  ): Promise<unknown> {
    return this.fields.create(authOf(req), body as CreateFieldInput);
  }

  @RequireScopes('custom_fields:manage')
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateFieldSchema)) body: unknown,
  ): Promise<unknown> {
    return this.fields.update(authOf(req), id, body as UpdateFieldInput);
  }

  @RequireScopes('custom_fields:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.fields.remove(authOf(req), id);
  }
}
