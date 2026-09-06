import type { RolePermissions } from '@nexus/db';

export interface AuthUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  status: 'invited' | 'active' | 'suspended';
  roleId: string;
}

export interface AuthRole {
  id: string;
  key: string;
  name: string;
  permissions: RolePermissions;
}

export interface AuthOrg {
  id: string;
  name: string;
  slug: string;
}

export interface AuthContext {
  sessionId: string;
  user: AuthUser;
  role: AuthRole;
  org: AuthOrg;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}
