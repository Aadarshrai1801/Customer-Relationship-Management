import {
  BadRequestException,
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
  Res,
  UnauthorizedException,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { createReadStream } from 'node:fs';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireScopes } from '../rbac/require-scopes.decorator';
import { CollaborationService } from './collaboration.service';
import { AttachmentsService, type MulterFile } from './attachments.service';
import {
  createCommentSchema,
  listAttachmentsQuerySchema,
  listCommentsQuerySchema,
  updateCommentSchema,
  type CreateCommentInput,
  type ListAttachmentsQuery,
  type ListCommentsQuery,
  type UpdateCommentInput,
} from './collaboration.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

const uploadBodySchema = z
  .object({
    entityType: z.enum(['contact', 'deal', 'task']),
    entityId: z.string().uuid(),
  })
  .strict();

@Controller('comments')
export class CommentsController {
  constructor(@Inject(CollaborationService) private readonly collaboration: CollaborationService) {}

  @RequireScopes('comments:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createCommentSchema)) body: unknown,
  ): Promise<unknown> {
    return this.collaboration.createComment(authOf(req), body as CreateCommentInput);
  }

  @RequireScopes('comments:read')
  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(listCommentsQuerySchema)) query: unknown,
  ): Promise<unknown> {
    return this.collaboration.listComments(authOf(req), query as ListCommentsQuery);
  }

  @RequireScopes('comments:manage')
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCommentSchema)) body: unknown,
  ): Promise<unknown> {
    return this.collaboration.updateComment(authOf(req), id, body as UpdateCommentInput);
  }

  @RequireScopes('comments:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.collaboration.removeComment(authOf(req), id);
  }
}

@Controller('attachments')
export class AttachmentsController {
  constructor(
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(CollaborationService) private readonly collaboration: CollaborationService,
  ) {}

  @RequireScopes('attachments:manage')
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      // Hard ceiling; the configurable per-file/org caps apply in-service.
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
  )
  async upload(
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodValidationPipe(uploadBodySchema)) body: unknown,
  ): Promise<unknown> {
    const { entityType, entityId } = body as {
      entityType: 'contact' | 'deal' | 'task';
      entityId: string;
    };
    if (!file) {
      throw new BadRequestException({ message: 'No file received', code: 'FILE_MISSING' });
    }
    return this.attachments.upload(authOf(req), entityType, entityId, file as MulterFile);
  }

  @RequireScopes('attachments:read')
  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(listAttachmentsQuerySchema)) query: unknown,
  ): Promise<unknown> {
    return this.collaboration.listAttachments(authOf(req), query as ListAttachmentsQuery);
  }

  @RequireScopes('attachments:read')
  @Get(':id/download')
  async download(
    @Req() req: Request,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.attachments.downloadPath(authOf(req), id);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Content-Length', String(file.size));
    createReadStream(file.path).pipe(res);
  }

  @RequireScopes('attachments:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.attachments.remove(authOf(req), id);
  }

  @RequireScopes('attachments:read')
  @Get('usage/summary')
  async usage(@Req() req: Request): Promise<unknown> {
    return this.attachments.usage(authOf(req));
  }
}
