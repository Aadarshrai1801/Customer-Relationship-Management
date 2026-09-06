import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';

export const SESSION_COOKIE_NAME = 'nx_session';

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function cookieOptions(maxAgeSeconds: number): {
  httpOnly: boolean;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  };
}

export function clearedCookieOptions(): {
  httpOnly: boolean;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  };
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  const maxAgeSeconds = Math.max(60, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  res.cookie(SESSION_COOKIE_NAME, token, cookieOptions(maxAgeSeconds));
}
