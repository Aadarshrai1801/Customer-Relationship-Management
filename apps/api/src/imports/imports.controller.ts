import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ImportsService, type UploadedFile as ServiceFile } from './imports.service';
import {
  mappingSchema,
  uploadQuerySchema,
  type MappingInput,
  type UploadQuery,
} from './imports.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('imports')
export class ImportsController {
  constructor(@Inject(ImportsService) private readonly imports: ImportsService) {}

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: join(tmpdir(), 'nexus-uploads'),
        filename: (_req, file, done) => {
          done(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname}`);
        },
      }),
      limits: { fileSize: 50 * 1024 * 1024 },
      fileFilter: (_req, file, done) => {
        const lower = file.originalname.toLowerCase();
        if (lower.endsWith('.csv') || lower.endsWith('.vcf')) done(null, true);
        else {
          done(
            new BadRequestException({
              message: 'Only .csv and .vcf files are supported',
              code: 'FILE_TYPE_INVALID',
            }),
            false,
          );
        }
      },
    }),
  )
  async upload(
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query(new ZodValidationPipe(uploadQuerySchema)) query: unknown,
  ): Promise<unknown> {
    const { entityType } = query as UploadQuery;
    return this.imports.upload(authOf(req), entityType, file as ServiceFile | undefined);
  }

  @Get()
  async list(@Req() req: Request): Promise<unknown> {
    return this.imports.listJobs(authOf(req));
  }

  @Get(':id')
  async get(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.imports.getJob(authOf(req), id);
  }

  @Post(':id/mapping')
  @HttpCode(HttpStatus.OK)
  async setMapping(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(mappingSchema)) body: unknown,
  ): Promise<unknown> {
    const { mapping } = body as MappingInput;
    return this.imports.setMapping(authOf(req), id, mapping);
  }

  @Post(':id/validate')
  @HttpCode(HttpStatus.OK)
  async validate(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.imports.requestValidate(authOf(req), id);
  }

  @Post(':id/commit')
  @HttpCode(HttpStatus.OK)
  async commit(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.imports.requestCommit(authOf(req), id);
  }
}
