import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import { DevicesService } from './devices.service';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

const registerDeviceSchema = z
  .object({
    token: z.string().trim().min(8).max(512),
    platform: z.enum(['web', 'ios', 'android']).default('web'),
  })
  .strict();

@Controller('devices')
export class DevicesController {
  constructor(@Inject(DevicesService) private readonly devices: DevicesService) {}

  @RequireScopes('notifications:read')
  @Post()
  async register(
    @Req() req: Request,
    @Body(new ZodValidationPipe(registerDeviceSchema)) body: unknown,
  ): Promise<unknown> {
    return this.devices.register(
      authOf(req),
      body as { token: string; platform?: string },
    );
  }

  @RequireScopes('notifications:read')
  @Get()
  async list(@Req() req: Request): Promise<unknown> {
    return this.devices.list(authOf(req));
  }

  @RequireScopes('notifications:read')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.devices.remove(authOf(req), id);
  }
}
