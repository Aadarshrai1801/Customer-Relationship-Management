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
import { SlaService } from './sla.service';
import {
  createSlaPolicySchema,
  updateSlaPolicySchema,
  type CreateSlaPolicyInput,
  type UpdateSlaPolicyInput,
} from './sla.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('sla-policies')
export class SlaController {
  constructor(@Inject(SlaService) private readonly sla: SlaService) {}

  @RequireScopes('org:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createSlaPolicySchema)) body: unknown,
  ): Promise<unknown> {
    return this.sla.createPolicy(authOf(req), body as CreateSlaPolicyInput);
  }

  @RequireScopes('org:read')
  @Get()
  async list(@Req() req: Request): Promise<unknown> {
    return this.sla.listPolicies(authOf(req));
  }

  @RequireScopes('org:manage')
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateSlaPolicySchema)) body: unknown,
  ): Promise<unknown> {
    return this.sla.updatePolicy(authOf(req), id, body as UpdateSlaPolicyInput);
  }

  @RequireScopes('org:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.sla.removePolicy(authOf(req), id);
  }

  @RequireScopes('org:read')
  @Get('breaches/list')
  async breaches(@Req() req: Request): Promise<unknown> {
    return this.sla.breaches(authOf(req));
  }
}
