import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export interface OrganizationSettings {
  timezone: string;
  locale: string;
  dateFormat: string;
}

export interface OrganizationSecuritySettings {
  twoFactorPolicy: 'off' | 'optional' | 'required';
  ssoOnly: boolean;
  passwordMinLength: number;
  sessionTtlDays: number;
}

export interface RolePermissions {
  version: 1;
  scopes: string[];
  recordAccess: Record<string, 'all' | 'own'>;
  fields: Record<string, 'edit' | 'read' | 'none'>;
}

export const DEFAULT_ORGANIZATION_SETTINGS: OrganizationSettings = {
  timezone: 'UTC',
  locale: 'en-US',
  dateFormat: 'YYYY-MM-DD',
};

export const DEFAULT_ORGANIZATION_SECURITY_SETTINGS: OrganizationSecuritySettings = {
  twoFactorPolicy: 'optional',
  ssoOnly: false,
  passwordMinLength: 12,
  sessionTtlDays: 14,
};

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  planTier: text('plan_tier').notNull().default('trial'),
  settings: jsonb('settings')
    .$type<OrganizationSettings>()
    .notNull()
    .default(DEFAULT_ORGANIZATION_SETTINGS),
  securitySettings: jsonb('security_settings')
    .$type<OrganizationSecuritySettings>()
    .notNull()
    .default(DEFAULT_ORGANIZATION_SECURITY_SETTINGS),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    permissions: jsonb('permissions')
      .$type<RolePermissions>()
      .notNull()
      .default({ version: 1, scopes: [], recordAccess: {}, fields: {} } as RolePermissions),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_roles_org_key').on(t.orgId, t.key)],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash'),
    status: text('status').$type<'invited' | 'active' | 'suspended'>().notNull().default('invited'),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    ssoSubject: text('sso_subject'),
    ssoProvider: text('sso_provider'),
    timezone: text('timezone').notNull().default('UTC'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_users_org_email').on(t.orgId, sql`lower(${t.email})`)],
);

export const emailInvites = pgTable(
  'email_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_email_invites_token_hash').on(t.tokenHash)],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_password_reset_tokens_token_hash').on(t.tokenHash)],
);

export const twoFactor = pgTable('two_factor', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  enabledAt: timestamp('enabled_at', { withTimezone: true }),
  backupCodes: text('backup_codes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ssoConfigs = pgTable(
  'sso_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<'saml' | 'oidc'>().notNull(),
    enabled: boolean('enabled').notNull().default(false),
    domains: text('domains').array().notNull().default([]),
    config: text('config').notNull(),
    defaultRoleKey: text('default_role_key').notNull().default('rep'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_sso_configs_org_provider').on(t.orgId, t.provider)],
);

export const ssoLoginStates = pgTable(
  'sso_login_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<'saml' | 'oidc'>().notNull(),
    stateHash: text('state_hash').notNull(),
    codeVerifier: text('code_verifier'),
    nonce: text('nonce'),
    samlRequestId: text('saml_request_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_sso_login_states_state_hash').on(t.stateHash)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    twoFactorVerified: boolean('two_factor_verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_sessions_token_hash').on(t.tokenHash)],
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type EmailInvite = typeof emailInvites.$inferSelect;
export type NewEmailInvite = typeof emailInvites.$inferInsert;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;
export type TwoFactor = typeof twoFactor.$inferSelect;
export type NewTwoFactor = typeof twoFactor.$inferInsert;
export type SsoConfig = typeof ssoConfigs.$inferSelect;
export type NewSsoConfig = typeof ssoConfigs.$inferInsert;
export type SsoLoginState = typeof ssoLoginStates.$inferSelect;

export * from './env';
