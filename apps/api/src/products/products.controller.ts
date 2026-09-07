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
import { ProductsService } from './products.service';
import {
  createProductSchema,
  updateProductSchema,
  type CreateProductInput,
  type UpdateProductInput,
} from './products.schemas';

function authOf(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
}

@Controller('products')
export class ProductsController {
  constructor(@Inject(ProductsService) private readonly products: ProductsService) {}

  @RequireScopes('deals:read')
  @Get()
  async list(@Req() req: Request): Promise<unknown> {
    return this.products.list(authOf(req));
  }

  @RequireScopes('deals:manage')
  @Post()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createProductSchema)) body: unknown,
  ): Promise<unknown> {
    return this.products.create(authOf(req), body as CreateProductInput);
  }

  @RequireScopes('deals:manage')
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: unknown,
  ): Promise<unknown> {
    return this.products.update(authOf(req), id, body as UpdateProductInput);
  }

  @RequireScopes('deals:manage')
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    return this.products.remove(authOf(req), id);
  }
}
