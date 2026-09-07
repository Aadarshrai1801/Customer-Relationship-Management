import { createHmac, timingSafeEqual } from 'node:crypto';

function signingKey(): string {
  const key = process.env.FIELD_ENCRYPTION_KEY;
  if (!key) throw new Error('FIELD_ENCRYPTION_KEY is required for tracking tokens');
  return key;
}

/**
 * Stateless open/click tokens (PRD 4.5 P1). HMAC binds activity+org so
 * tokens cannot be forged across records; verification needs no lookup
 * before deciding to serve the pixel (always 200) or redirect.
 */
export function signTrackingToken(activityId: string, orgId: string): string {
  const payload = `${orgId}.${activityId}`;
  const mac = createHmac('sha256', signingKey()).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

export function verifyTrackingToken(token: string): { activityId: string; orgId: string } | null {
  const parts = token.split('.');
  if (parts.length < 3) return null;
  const mac = parts.pop() as string;
  const payload = parts.join('.');
  const expected = createHmac('sha256', signingKey()).update(payload).digest('hex');
  if (mac.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  const sep = payload.indexOf('.');
  if (sep < 0) return null;
  return { orgId: payload.slice(0, sep), activityId: payload.slice(sep + 1) };
}

const URL_PATTERN = /https?:\/\/[^\s<>"')]+/g;

/** Rewrites body links through the click endpoint; leaves text readable. */
export function rewriteLinksForTracking(body: string, clickBase: string): string {
  return body.replace(URL_PATTERN, (url) => {
    const trailing = url.match(/[.,;:!?]+$/)?.[0] ?? '';
    const clean = trailing ? url.slice(0, -trailing.length) : url;
    return `${clickBase}?u=${encodeURIComponent(clean)}${trailing}`;
  });
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Renders {{variable}} placeholders (shared by templates and sequence
 * steps). Unknown keys render empty rather than failing the send.
 */
export function renderTemplateText(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = variables[key];
    if (value === null || value === undefined) return '';
    return typeof value === 'string' ? value : String(value);
  });
}
