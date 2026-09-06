export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(status: number, body: unknown) {
    const typed = body as { message?: string; code?: string } | null;
    super(typed?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = typed?.code;
    this.details = body;
  }
}

export async function api<T>(
  path: string,
  init?: Omit<RequestInit, 'body'> & { body?: unknown },
): Promise<T> {
  const { body, headers, ...rest } = init ?? {};
  const res = await fetch(`${API_URL}/v1${path}`, {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...rest,
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export interface RoleRef {
  id: string;
  key: string;
  name: string;
  permissions?: RolePermissions;
}

export interface RolePermissions {
  version: 1;
  scopes: string[];
  recordAccess: Record<string, 'all' | 'own'>;
  fields: Record<string, 'edit' | 'read' | 'none'>;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  status: string;
  twoFactorEnrolled?: boolean;
  role: RoleRef;
}

export interface SessionOrg {
  id: string;
  name: string;
  slug: string;
}

export interface TwoFactorState {
  enrolled: boolean;
  required: boolean;
  verified: boolean;
}

export interface AuthResponse {
  user: SessionUser;
  org: SessionOrg;
  twoFactor: TwoFactorState;
}

export interface MeResponse {
  user: SessionUser;
  org: SessionOrg;
}

export interface OrgSecuritySettings {
  twoFactorPolicy: 'off' | 'optional' | 'required';
  ssoOnly: boolean;
  passwordMinLength: number;
  sessionTtlDays: number;
}

export interface OrgDetails extends SessionOrg {
  planTier: string;
  settings: Record<string, unknown>;
  securitySettings: OrgSecuritySettings;
}

export interface DirectoryUser {
  id: string;
  name: string;
  status: string;
  timezone: string;
  role: { id: string; key: string; name: string };
  createdAt: string;
  email?: string;
}

export interface RoleDetails {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  permissions: RolePermissions;
  createdAt: string;
}

export interface SsoConfigSummary {
  id: string;
  provider: 'saml' | 'oidc';
  enabled: boolean;
  domains: string[];
  defaultRoleKey: string;
  issuer?: string;
  idpSsoUrl?: string;
  idpEntityId?: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: number;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface ExportSummary {
  id: string;
  status: string;
  checksum: string | null;
  expiresAt: string | null;
  createdAt: string;
  completedAt: string | null;
  error?: string;
}

export function hasScope(user: SessionUser | null, scope: string): boolean {
  const scopes = user?.role.permissions?.scopes ?? [];
  return scopes.includes('*') || scopes.includes(scope);
}
