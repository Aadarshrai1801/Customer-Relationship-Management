import { SetMetadata } from '@nestjs/common';

export const REQUIRED_SCOPES_KEY = 'nexus:requiredScopes';

export const RequireScopes = (...scopes: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_SCOPES_KEY, scopes);
