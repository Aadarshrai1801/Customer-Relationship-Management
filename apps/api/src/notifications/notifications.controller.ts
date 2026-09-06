import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import {
  listNotificationsQuerySchema,
  type ListNotificationsQuery,
} from './notifications.schemas';
import { NotificationsService } from './notifications.service';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('notifications')
export class NotificationsController {
  constructor(
    @Inject(NotificationsService)
    private readonly notificationsService: NotificationsService,
  ) {}

  @RequireScopes('notifications:read')
  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(listNotificationsQuerySchema)) query: unknown,
  ): Promise<unknown> {
    const auth = authOf(req);
    return this.notificationsService.list(
      auth.org.id,
      auth.user.id,
      query as ListNotificationsQuery,
    );
  }

  @RequireScopes('notifications:read')
  @Patch(':id/read')
  async markAsRead(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    const auth = authOf(req);
    return this.notificationsService.markAsRead(auth.org.id, auth.user.id, id);
  }

  @RequireScopes('notifications:read')
  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  async markAllAsRead(@Req() req: Request): Promise<unknown> {
    const auth = authOf(req);
    return this.notificationsService.markAllAsRead(auth.org.id, auth.user.id);
  }
}
