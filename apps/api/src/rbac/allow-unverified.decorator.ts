import { SetMetadata } from '@nestjs/common';

export const ALLOW_UNVERIFIED_KEY = 'nexus:allowUnverified2fa';

/**
 * Marks routes reachable with a 2FA-unverified session (the 2FA ceremony
 * itself). Everything else requires a fully verified session.
 */
export const AllowUnverified = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_UNVERIFIED_KEY, true);
