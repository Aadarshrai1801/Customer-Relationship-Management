import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
  uuid,
  bigserial,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
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

export const auditLogEntries = pgTable('audit_log_entries', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  actorEmail: text('actor_email'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  oldValues: jsonb('old_values').$type<Record<string, unknown> | null>(),
  newValues: jsonb('new_values').$type<Record<string, unknown> | null>(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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

export const gdprExports = pgTable('gdpr_exports', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  status: text('status')
    .$type<'pending' | 'processing' | 'ready' | 'failed' | 'expired'>()
    .notNull()
    .default('pending'),
  storageKey: text('storage_key'),
  fileSize: text('file_size'),
  checksum: text('checksum'),
  error: text('error'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

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
export type AuditLogEntry = typeof auditLogEntries.$inferSelect;
export type NewAuditLogEntry = typeof auditLogEntries.$inferInsert;
export type GdprExport = typeof gdprExports.$inferSelect;
export type NewGdprExport = typeof gdprExports.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type CustomFieldDefinition = typeof customFieldDefinitions.$inferSelect;
export type NewCustomFieldDefinition = typeof customFieldDefinitions.$inferInsert;
export type ContactNote = typeof contactNotes.$inferSelect;
export type DuplicateCandidate = typeof duplicateCandidates.$inferSelect;
export type ContactMerge = typeof contactMerges.$inferSelect;
export type ImportJob = typeof importJobs.$inferSelect;

export const LIFECYCLE_STAGES = [
  'lead',
  'mql',
  'sql',
  'opportunity',
  'customer',
  'evangelist',
  'other',
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const CUSTOM_FIELD_TYPES = [
  'text',
  'number',
  'date',
  'picklist',
  'multi_select',
  'checkbox',
  'currency',
  'formula',
] as const;

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    website: text('website'),
    domains: text('domains').array().notNull().default([]),
    phone: text('phone'),
    industry: text('industry'),
    parentId: uuid('parent_id').references((): AnyPgColumn => accounts.id, {
      onDelete: 'set null',
    }),
    tags: text('tags').array().notNull().default([]),
    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_accounts_org_parent').on(t.orgId, t.parentId)],
);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    email: text('email').notNull(),
    phone: text('phone'),
    title: text('title'),
    lifecycleStage: text('lifecycle_stage').notNull().default('lead'),
    tags: text('tags').array().notNull().default([]),
    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    mergedIntoId: uuid('merged_into_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_contacts_org_email').on(t.orgId, sql`lower(${t.email})`),
    index('ix_contacts_org_account').on(t.orgId, t.accountId),
    index('ix_contacts_org_owner').on(t.orgId, t.ownerId),
  ],
);

export const customFieldDefinitions = pgTable(
  'custom_field_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').$type<'contact' | 'account'>().notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type').$type<CustomFieldType>().notNull(),
    required: boolean('required').notNull().default(false),
    options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_custom_fields_org_entity_key').on(t.orgId, t.entityType, t.key)],
);

export const contactNotes = pgTable(
  'contact_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_notes_org_contact').on(t.orgId, t.contactId)],
);

export const duplicateCandidates = pgTable(
  'duplicate_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').$type<'contact' | 'account'>().notNull(),
    recordAId: uuid('record_a_id').notNull(),
    recordBId: uuid('record_b_id').notNull(),
    confidence: text('confidence').$type<'exact' | 'high' | 'medium'>().notNull(),
    signals: jsonb('signals').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').$type<'pending' | 'dismissed' | 'merged'>().notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('uq_dup_candidate_pair').on(t.orgId, t.entityType, t.recordAId, t.recordBId)],
);

export const contactMerges = pgTable('contact_merges', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  winnerId: uuid('winner_id').notNull(),
  loserId: uuid('loser_id').notNull(),
  loserSnapshot: jsonb('loser_snapshot').$type<Record<string, unknown>>().notNull(),
  fieldChoices: jsonb('field_choices').$type<Record<string, 'winner' | 'loser'>>().notNull(),
  mergedBy: uuid('merged_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const importJobs = pgTable('import_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  entityType: text('entity_type').$type<'contact' | 'account'>().notNull().default('contact'),
  status: text('status')
    .$type<
      | 'pending'
      | 'validating'
      | 'validated'
      | 'validation_failed'
      | 'importing'
      | 'completed'
      | 'failed'
    >()
    .notNull()
    .default('pending'),
  mapping: jsonb('mapping').$type<Record<string, string>>().notNull().default({}),
  stats: jsonb('stats').$type<Record<string, unknown>>().notNull().default({}),
  error: text('error'),
  storageKey: text('storage_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export * from './env';
