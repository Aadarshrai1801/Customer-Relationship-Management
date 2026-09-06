import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

export interface RequestMetadata {
  ipAddress?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestMetadata>();

export function requestMetadata(): RequestMetadata {
  return storage.getStore() ?? {};
}

export function requestContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const userAgent = req.headers['user-agent'];
  storage.run(
    {
      ipAddress: req.ip,
      userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent,
    },
    () => next(),
  );
}
