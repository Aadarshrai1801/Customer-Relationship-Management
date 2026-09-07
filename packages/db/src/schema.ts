import {
  boolean,
  date,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
  uuid,
  bigserial,
  integer,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export interface OrganizationSettings {
  timezone: string;
  locale: string;
  dateFormat: string;
  baseCurrency: string;
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
  baseCurrency: 'USD',
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
export type Pipeline = typeof pipelines.$inferSelect;
export type NewPipeline = typeof pipelines.$inferInsert;
export type PipelineStage = typeof pipelineStages.$inferSelect;
export type NewPipelineStage = typeof pipelineStages.$inferInsert;
export type Deal = typeof deals.$inferSelect;
export type NewDeal = typeof deals.$inferInsert;
export type DealStageHistory = typeof dealStageHistory.$inferSelect;
export type ExchangeRate = typeof exchangeRates.$inferSelect;
export type Product = typeof products.$inferSelect;
export type DealLineItem = typeof dealLineItems.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Activity = typeof activities.$inferSelect;
export type NewActivity = typeof activities.$inferInsert;
export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type NewEmailTemplate = typeof emailTemplates.$inferInsert;

/**
 * Module 6 (PRD 4.5 P0): reusable email templates with {{variable}}
 * rendering. Variables are substituted at send time; unknown keys render
 * empty rather than failing the send.
 */
export const emailTemplates = pgTable(
  'email_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_email_templates_org_name').on(t.orgId, t.name),
    uniqueIndex('uq_email_templates_org_name').on(t.orgId, t.name),
  ],
);
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
export type AccountMerge = typeof accountMerges.$inferSelect;
export type ImportJob = typeof importJobs.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type LeadRoutingRule = typeof leadRoutingRules.$inferSelect;
export type NewLeadRoutingRule = typeof leadRoutingRules.$inferInsert;
export type LeadRoutingMember = typeof leadRoutingMembers.$inferSelect;
export type NewLeadRoutingMember = typeof leadRoutingMembers.$inferInsert;
export type RepAvailability = typeof repAvailability.$inferSelect;
export type NewRepAvailability = typeof repAvailability.$inferInsert;
export type LeadAssignmentLog = typeof leadAssignmentLogs.$inferSelect;
export type NewLeadAssignmentLog = typeof leadAssignmentLogs.$inferInsert;
export type AppNotification = typeof notifications.$inferSelect;
export type NewAppNotification = typeof notifications.$inferInsert;

export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified', 'converted'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_SOURCES = [
  'website',
  'referral',
  'organic_search',
  'paid_search',
  'event',
  'other',
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

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
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    tags: text('tags').array().notNull().default([]),
    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_accounts_org_parent').on(t.orgId, t.parentId),
    index('ix_accounts_org_owner').on(t.orgId, t.ownerId),
  ],
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
    entityType: text('entity_type').$type<'contact' | 'account' | 'lead' | 'deal'>().notNull(),
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

export const accountMerges = pgTable('account_merges', {
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

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    email: text('email').notNull(),
    phone: text('phone'),
    company: text('company'),
    title: text('title'),
    status: text('status').$type<LeadStatus>().notNull().default('new'),
    source: text('source').$type<LeadSource>().notNull().default('website'),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmTerm: text('utm_term'),
    utmContent: text('utm_content'),
    referrerUrl: text('referrer_url'),
    notes: text('notes'),
    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
    convertedAt: timestamp('converted_at', { withTimezone: true }),
    convertedContactId: uuid('converted_contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    convertedAccountId: uuid('converted_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_leads_org_email').on(t.orgId, sql`lower(${t.email})`),
    index('ix_leads_org_status').on(t.orgId, t.status),
    index('ix_leads_org_owner').on(t.orgId, t.ownerId),
    index('ix_leads_org_created').on(t.orgId, t.createdAt),
  ],
);

export const leadRoutingRules = pgTable(
  'lead_routing_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    strategy: text('strategy').$type<'round_robin' | 'manual'>().notNull().default('round_robin'),
    isActive: boolean('is_active').notNull().default(true),
    fallbackUserId: uuid('fallback_user_id').references(() => users.id, { onDelete: 'set null' }),
    lastAssignedIndex: integer('last_assigned_index').notNull().default(-1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_lead_routing_rules_org').on(t.orgId, t.isActive)],
);

export const leadRoutingMembers = pgTable(
  'lead_routing_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => leadRoutingRules.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orderIndex: integer('order_index').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_lead_routing_member').on(t.ruleId, t.userId),
    index('ix_lead_routing_members_rule').on(t.ruleId, t.orderIndex),
  ],
);

export const repAvailability = pgTable(
  'rep_availability',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    isAvailable: boolean('is_available').notNull().default(true),
    oooReason: text('ooo_reason'),
    returnAt: timestamp('return_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_rep_availability_org_user').on(t.orgId, t.userId)],
);

export const leadAssignmentLogs = pgTable(
  'lead_assignment_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    assignedToUserId: uuid('assigned_to_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    assignedByUserId: uuid('assigned_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ruleId: uuid('rule_id').references(() => leadRoutingRules.id, { onDelete: 'set null' }),
    strategy: text('strategy').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_lead_assignment_logs_lead').on(t.orgId, t.leadId)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    link: text('link'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_notifications_user_read').on(t.orgId, t.userId, t.readAt)],
);

export const pipelines = pgTable(
  'pipelines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_pipelines_org_slug').on(t.orgId, t.slug)],
);

export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    probability: integer('probability').notNull(),
    isClosedWon: boolean('is_closed_won').notNull().default(false),
    isClosedLost: boolean('is_closed_lost').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_pipeline_stages_pipeline_key').on(t.pipelineId, t.key),
    uniqueIndex('uq_pipeline_stages_pipeline_position').on(t.pipelineId, t.position),
    index('ix_pipeline_stages_pipeline_position').on(t.pipelineId, t.position),
  ],
);

export const deals = pgTable(
  'deals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'restrict' }),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => pipelineStages.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    amount: numeric('amount', { precision: 19, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    baseCurrency: text('base_currency').notNull(),
    baseAmount: numeric('base_amount', { precision: 19, scale: 2 }).notNull(),
    exchangeRate: numeric('exchange_rate', { precision: 19, scale: 6 }).notNull(),
    exchangeRateDate: date('exchange_rate_date', { mode: 'string' }).notNull(),
    probability: integer('probability'),
    expectedCloseDate: timestamp('expected_close_date', { withTimezone: true }),
    status: text('status').$type<'open' | 'won' | 'lost'>().notNull().default('open'),
    lossReason: text('loss_reason'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_deals_org_pipeline_stage').on(t.orgId, t.pipelineId, t.stageId),
    index('ix_deals_org_owner').on(t.orgId, t.ownerId),
    index('ix_deals_org_account').on(t.orgId, t.accountId),
    index('ix_deals_org_close').on(t.orgId, t.expectedCloseDate),
  ],
);

export const dealStageHistory = pgTable(
  'deal_stage_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id, { onDelete: 'cascade' }),
    fromStageId: uuid('from_stage_id').references(() => pipelineStages.id, {
      onDelete: 'set null',
    }),
    toStageId: uuid('to_stage_id').references(() => pipelineStages.id, { onDelete: 'set null' }),
    fromStageName: text('from_stage_name'),
    toStageName: text('to_stage_name').notNull(),
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
    exitedAt: timestamp('exited_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('ix_deal_stage_history_deal').on(t.orgId, t.dealId, t.enteredAt)],
);

export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    rateDate: date('rate_date', { mode: 'string' }).notNull(),
    baseCurrency: text('base_currency').notNull(),
    rates: jsonb('rates').$type<Record<string, number>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_exchange_rates_org_date_base').on(t.orgId, t.rateDate, t.baseCurrency),
    index('ix_exchange_rates_org_base_date').on(t.orgId, t.baseCurrency, t.rateDate),
  ],
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sku: text('sku'),
    unitPrice: numeric('unit_price', { precision: 19, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    taxRate: numeric('tax_rate', { precision: 7, scale: 4 }).notNull().default('0'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_products_org_active').on(t.orgId, t.isActive)],
);

export const dealLineItems = pgTable(
  'deal_line_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 19, scale: 2 }).notNull(),
    discountRate: numeric('discount_rate', { precision: 7, scale: 4 }).notNull().default('0'),
    taxRate: numeric('tax_rate', { precision: 7, scale: 4 }).notNull().default('0'),
    lineTotal: numeric('line_total', { precision: 19, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_deal_line_items_deal').on(t.orgId, t.dealId)],
);

/**
 * Module 5 (PRD 4.4 P0): tasks with due/reminder tracking. Status is
 * open | completed | cancelled; priority is low | normal | high.
 * Links to CRM records are nullable set-null FKs so deleting a contact,
 * account, or deal never deletes the task itself.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    dealId: uuid('deal_id').references(() => deals.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().default('open'),
    priority: text('priority').notNull().default('normal'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    remindAt: timestamp('remind_at', { withTimezone: true }),
    reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_tasks_org_owner').on(t.orgId, t.ownerId),
    index('ix_tasks_org_due').on(t.orgId, t.dueAt),
  ],
);

/**
 * Module 5 (PRD 4.4 P0): unified activity log for calls, meetings, emails,
 * and task completions. Contact notes stay in contact_notes (existing
 * feature); the timeline merges both sources.
 *
 * Calendar sync (google | outlook) writes here: provider + external_id is
 * unique per org for idempotent re-syncs. Deleting an event in the provider
 * flips sync_status to cancelled (never hard-deleted). external_updated_at
 * tracks the provider's last-modified time; conflict_flag marks edits that
 * raced a local change (most-recent-wins, flagged for the user).
 */
export const activities = pgTable(
  'activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    dealId: uuid('deal_id').references(() => deals.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    subject: text('subject'),
    body: text('body'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    provider: text('provider'),
    externalId: text('external_id'),
    externalUpdatedAt: timestamp('external_updated_at', { withTimezone: true }),
    syncStatus: text('sync_status').notNull().default('active'),
    conflictFlag: boolean('conflict_flag').notNull().default(false),
    // Module 6 (PRD 4.5): email addressing. direction is inbound | outbound.
    direction: text('direction').notNull().default('inbound'),
    senderEmail: text('sender_email'),
    recipientEmails: text('recipient_emails').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_activities_org_contact').on(t.orgId, t.contactId),
    index('ix_activities_org_occurred').on(t.orgId, t.occurredAt),
    uniqueIndex('uq_activities_org_provider_external').on(t.orgId, t.provider, t.externalId),
  ],
);

export * from './env';
