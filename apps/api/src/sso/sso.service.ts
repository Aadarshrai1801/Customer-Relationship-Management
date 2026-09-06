import { createHash, randomBytes } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  organizations,
  roles,
  ssoConfigs,
  ssoLoginStates,
  twoFactor,
  users,
  type Organization,
  type SsoConfig,
} from '@nexus/db';
import { IdentityDb, TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService, diffObjects } from '../audit/audit.service';
import { FieldCrypto } from '../crypto/crypto.module';
import { SessionService } from '../auth/session.service';
import type { CreatedSession } from '../auth/session.service';
import {
  toPublicOrg,
  toPublicUser,
  type PublicOrg,
  type PublicUser,
  type TwoFactorState,
} from '../auth/auth-shapes';
import type { CreateSsoConfigInput, SsoConfigJson, UpdateSsoConfigInput } from './sso.schemas';

const CONFIG_PURPOSE = 'sso-config-v1';
const STATE_PURPOSE = 'sso-state-v1';
const STATE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface RedactedSsoConfig {
  id: string;
  provider: 'saml' | 'oidc';
  enabled: boolean;
  domains: string[];
  defaultRoleKey: string;
  issuer?: string;
  idpSsoUrl?: string;
  idpEntityId?: string;
  updatedAt: Date;
}

export interface SsoLoginResult {
  user: PublicUser;
  org: PublicOrg;
  session: CreatedSession;
  twoFactor: TwoFactorState;
}

function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

function isHttpLocalhost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

async function fetchText(url: string, maxBytes: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > maxBytes) throw new Error('Response too large');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

const metadataParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function parseIdpMetadata(xml: string): {
  idpEntityId: string;
  idpSsoUrl: string;
  idpCert: string;
} {
  let doc: Record<string, unknown>;
  try {
    doc = metadataParser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new BadRequestException({
      message: 'IdP metadata is not valid XML',
      code: 'SSO_METADATA_INVALID',
    });
  }
  const descriptor = (doc['EntityDescriptor'] ?? doc['md:EntityDescriptor']) as
    Record<string, unknown> | undefined;
  if (!descriptor || typeof descriptor !== 'object') {
    throw new BadRequestException({
      message: 'IdP metadata has no EntityDescriptor',
      code: 'SSO_METADATA_INVALID',
    });
  }
  const idpEntityId = (descriptor['@_entityID'] ?? descriptor['@_entityId']) as string | undefined;
  const ssoDescriptor = (descriptor['IDPSSODescriptor'] ?? descriptor['md:IDPSSODescriptor']) as
    Record<string, unknown> | undefined;
  if (!idpEntityId || !ssoDescriptor) {
    throw new BadRequestException({
      message: 'IdP metadata has no IDPSSODescriptor',
      code: 'SSO_METADATA_INVALID',
    });
  }
  const services = asArray(
    (ssoDescriptor['SingleSignOnService'] ?? ssoDescriptor['md:SingleSignOnService']) as
      Array<Record<string, string>> | Record<string, string> | undefined,
  );
  const redirect = services.find((s) => (s['@_Binding'] ?? '').includes('HTTP-Redirect'));
  const chosen = redirect ?? services[0];
  const idpSsoUrl = chosen?.['@_Location'];
  const keyDescriptors = asArray(
    (ssoDescriptor['KeyDescriptor'] ?? ssoDescriptor['md:KeyDescriptor']) as
      Array<Record<string, unknown>> | Record<string, unknown> | undefined,
  );
  const signing =
    keyDescriptors.find((k) => (k['@_use'] ?? 'signing') === 'signing') ?? keyDescriptors[0];
  const keyInfo = (signing?.['KeyInfo'] ?? signing?.['ds:KeyInfo']) as
    Record<string, unknown> | undefined;
  const x509Data = (keyInfo?.['X509Data'] ?? keyInfo?.['ds:X509Data']) as
    Record<string, unknown> | undefined;
  const certBody = String(
    x509Data?.['X509Certificate'] ?? x509Data?.['ds:X509Certificate'] ?? '',
  ).replace(/\s+/g, '');
  if (!idpEntityId || !idpSsoUrl || !certBody) {
    throw new BadRequestException({
      message: 'IdP metadata is missing entityID, SingleSignOnService, or signing certificate',
      code: 'SSO_METADATA_INVALID',
    });
  }
  const idpCert = `-----BEGIN CERTIFICATE-----\n${certBody.replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----`;
  return { idpEntityId, idpSsoUrl, idpCert };
}

@Injectable()
export class SsoService {
  constructor(
    @Inject(IdentityDb) private readonly identityDb: IdentityDb,
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  apiOrigin(): string {
    return process.env.API_ORIGIN ?? 'http://localhost:3001';
  }

  webOrigin(): string {
    return (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',')[0]!;
  }

  samlEntityId(orgSlug: string): string {
    return `${this.apiOrigin()}/v1/auth/sso/saml/${orgSlug}`;
  }

  samlAcsUrl(orgSlug: string): string {
    return `${this.apiOrigin()}/v1/auth/sso/saml/${orgSlug}/acs`;
  }

  oidcCallbackUrl(orgSlug: string): string {
    return `${this.apiOrigin()}/v1/auth/sso/oidc/${orgSlug}/callback`;
  }

  successRedirect(): string {
    return `${this.webOrigin()}/sso/success`;
  }

  errorRedirect(code: string): string {
    return `${this.webOrigin()}/sso/error?code=${encodeURIComponent(code)}`;
  }

  async orgBySlug(orgSlug: string): Promise<Organization> {
    const [org] = await this.identityDb.db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, orgSlug.toLowerCase()));
    if (!org) {
      throw new NotFoundException({ message: 'Workspace not found', code: 'SSO_ORG_NOT_FOUND' });
    }
    return org;
  }

  async enabledConfig(orgId: string, provider: 'saml' | 'oidc'): Promise<SsoConfig> {
    const [row] = await this.identityDb.db
      .select()
      .from(ssoConfigs)
      .where(
        and(
          eq(ssoConfigs.orgId, orgId),
          eq(ssoConfigs.provider, provider),
          eq(ssoConfigs.enabled, true),
        ),
      );
    if (!row) {
      throw new NotFoundException({
        message: `Single sign-on (${provider}) is not enabled for this workspace`,
        code: 'SSO_NOT_CONFIGURED',
      });
    }
    return row;
  }

  decryptConfig(row: SsoConfig): SsoConfigJson {
    return JSON.parse(this.crypto.decrypt(row.config, CONFIG_PURPOSE)) as SsoConfigJson;
  }

  async resolveByEmail(
    email: string,
  ): Promise<Array<{ orgSlug: string; orgName: string; providers: Array<'saml' | 'oidc'> }>> {
    const domain = email.trim().toLowerCase().split('@')[1] ?? '';
    if (!domain) return [];
    const rows = await this.identityDb.db
      .select({ config: ssoConfigs, org: organizations })
      .from(ssoConfigs)
      .innerJoin(organizations, eq(ssoConfigs.orgId, organizations.id))
      .where(eq(ssoConfigs.enabled, true));
    const byOrg = new Map<
      string,
      { orgSlug: string; orgName: string; providers: Set<'saml' | 'oidc'> }
    >();
    for (const row of rows) {
      if (!row.config.domains.map((d) => d.toLowerCase()).includes(domain)) continue;
      const entry = byOrg.get(row.org.id) ?? {
        orgSlug: row.org.slug,
        orgName: row.org.name,
        providers: new Set<'saml' | 'oidc'>(),
      };
      entry.providers.add(row.config.provider);
      byOrg.set(row.org.id, entry);
    }
    return [...byOrg.values()].map((e) => ({ ...e, providers: [...e.providers] }));
  }

  async listConfigs(auth: AuthContext): Promise<RedactedSsoConfig[]> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const rows = await db.select().from(ssoConfigs).where(eq(ssoConfigs.orgId, auth.org.id));
      return rows.map((row) => this.redact(row));
    });
  }

  async createConfig(auth: AuthContext, input: CreateSsoConfigInput): Promise<RedactedSsoConfig> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [existing] = await db
        .select({ id: ssoConfigs.id })
        .from(ssoConfigs)
        .where(and(eq(ssoConfigs.orgId, auth.org.id), eq(ssoConfigs.provider, input.provider)));
      if (existing) {
        throw new ConflictException({
          message: 'A config for this provider already exists',
          code: 'SSO_CONFIG_EXISTS',
        });
      }
      await this.assertDefaultRole(db, auth.org.id, input.defaultRoleKey);
      const json = await this.buildConfigJson(input);
      const [created] = await db
        .insert(ssoConfigs)
        .values({
          orgId: auth.org.id,
          provider: input.provider,
          enabled: false,
          domains: input.domains,
          config: this.crypto.encrypt(JSON.stringify(json), CONFIG_PURPOSE),
          defaultRoleKey: input.defaultRoleKey,
        })
        .returning();
      if (!created) throw new Error('Failed to create SSO config');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'sso.config.created',
        entityType: 'sso_config',
        entityId: created.id,
        newValues: {
          provider: created.provider,
          domains: created.domains,
          defaultRoleKey: created.defaultRoleKey,
        },
      });
      return this.redact(created);
    });
  }

  async updateConfig(
    auth: AuthContext,
    id: string,
    input: UpdateSsoConfigInput,
  ): Promise<RedactedSsoConfig> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [row] = await db
        .select()
        .from(ssoConfigs)
        .where(and(eq(ssoConfigs.id, id), eq(ssoConfigs.orgId, auth.org.id)));
      if (!row) {
        throw new NotFoundException({
          message: 'SSO config not found',
          code: 'SSO_CONFIG_NOT_FOUND',
        });
      }
      if (input.defaultRoleKey) {
        await this.assertDefaultRole(db, auth.org.id, input.defaultRoleKey);
      }
      let json = this.decryptConfig(row);
      const secretsRotated = !!(input.oidc || input.saml);
      if (secretsRotated) {
        json = await this.buildConfigJson({
          provider: row.provider,
          domains: row.domains,
          defaultRoleKey: input.defaultRoleKey ?? row.defaultRoleKey,
          oidc: input.oidc,
          saml: input.saml,
        } as CreateSsoConfigInput);
      }
      if (input.enabled === false) {
        await this.assertDisablingAllowed(db, auth.org.id, row.id);
      }
      const [updated] = await db
        .update(ssoConfigs)
        .set({
          enabled: input.enabled ?? row.enabled,
          domains: input.domains ?? row.domains,
          defaultRoleKey: input.defaultRoleKey ?? row.defaultRoleKey,
          config:
            JSON.stringify(json) === JSON.stringify(this.decryptConfig(row))
              ? row.config
              : this.crypto.encrypt(JSON.stringify(json), CONFIG_PURPOSE),
          updatedAt: new Date(),
        })
        .where(eq(ssoConfigs.id, row.id))
        .returning();
      if (!updated) throw new Error('Failed to update SSO config');
      const { oldValues, newValues } = diffObjects(
        { enabled: row.enabled, domains: row.domains, defaultRoleKey: row.defaultRoleKey },
        {
          enabled: updated.enabled,
          domains: updated.domains,
          defaultRoleKey: updated.defaultRoleKey,
        },
      );
      if (Object.keys(newValues).length > 0 || secretsRotated) {
        await this.audit.record(db, {
          orgId: auth.org.id,
          actorUserId: auth.user.id,
          actorEmail: auth.user.email,
          action: 'sso.config.updated',
          entityType: 'sso_config',
          entityId: updated.id,
          oldValues,
          newValues: secretsRotated ? { ...newValues, credentialsRotated: true } : newValues,
        });
      }
      return this.redact(updated);
    });
  }

  async deleteConfig(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [row] = await db
        .select()
        .from(ssoConfigs)
        .where(and(eq(ssoConfigs.id, id), eq(ssoConfigs.orgId, auth.org.id)));
      if (!row) {
        throw new NotFoundException({
          message: 'SSO config not found',
          code: 'SSO_CONFIG_NOT_FOUND',
        });
      }
      if (row.enabled) {
        await this.assertDisablingAllowed(db, auth.org.id, row.id);
      }
      await db.delete(ssoConfigs).where(eq(ssoConfigs.id, row.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'sso.config.deleted',
        entityType: 'sso_config',
        entityId: row.id,
        oldValues: { provider: row.provider },
      });
      return { ok: true as const };
    });
  }

  async createStateRow(input: {
    orgId: string;
    provider: 'saml' | 'oidc';
    codeVerifier?: string;
    nonce?: string;
    samlRequestId?: string;
  }): Promise<{ state: string; rowId: string }> {
    const state = randomBytes(32).toString('base64url');
    const [inserted] = await this.identityDb.db
      .insert(ssoLoginStates)
      .values({
        orgId: input.orgId,
        provider: input.provider,
        stateHash: hashState(state),
        codeVerifier:
          input.codeVerifier || input.nonce
            ? this.crypto.encrypt(
                JSON.stringify({ v: input.codeVerifier ?? null, n: input.nonce ?? null }),
                STATE_PURPOSE,
              )
            : null,
        samlRequestId: input.samlRequestId ?? null,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      })
      .returning({ id: ssoLoginStates.id });
    if (!inserted) throw new Error('Failed to create login state');
    await this.identityDb.db.delete(ssoLoginStates).where(sql`${ssoLoginStates.expiresAt} < now()`);
    return { state, rowId: inserted.id };
  }

  async consumeStateRow(
    provider: 'saml' | 'oidc',
    state: string,
  ): Promise<{
    orgId: string;
    codeVerifier: string | null;
    nonce: string | null;
    samlRequestId: string | null;
  }> {
    const [row] = await this.identityDb.db
      .select()
      .from(ssoLoginStates)
      .where(
        and(eq(ssoLoginStates.stateHash, hashState(state)), eq(ssoLoginStates.provider, provider)),
      );
    if (!row || row.consumedAt) {
      throw new BadRequestException({
        message: 'Login session is invalid or was already used',
        code: 'SSO_STATE_INVALID',
      });
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException({
        message: 'Login session expired — start again',
        code: 'SSO_STATE_EXPIRED',
      });
    }
    await this.identityDb.db
      .update(ssoLoginStates)
      .set({ consumedAt: new Date() })
      .where(eq(ssoLoginStates.id, row.id));
    const secrets = row.codeVerifier
      ? (JSON.parse(this.crypto.decrypt(row.codeVerifier, STATE_PURPOSE)) as {
          v: string | null;
          n: string | null;
        })
      : { v: null, n: null };
    return {
      orgId: row.orgId,
      codeVerifier: secrets.v,
      nonce: secrets.n,
      samlRequestId: row.samlRequestId,
    };
  }

  async provisionOrLinkAndIssue(input: {
    orgId: string;
    provider: 'saml' | 'oidc';
    subject: string;
    email: string;
    name?: string;
    meta: { ipAddress?: string; userAgent?: string };
  }): Promise<SsoLoginResult> {
    const emailLower = input.email.trim().toLowerCase();
    const provisioned = await this.tenantDb.tx(input.orgId, async (db) => {
      const [org] = await db.select().from(organizations).where(eq(organizations.id, input.orgId));
      if (!org)
        throw new NotFoundException({ message: 'Workspace not found', code: 'ORG_NOT_FOUND' });
      const [match] = await db
        .select({ user: users, role: roles })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(and(eq(users.orgId, input.orgId), sql`lower(${users.email}) = ${emailLower}`));
      if (match?.user.status === 'suspended') {
        throw new ForbiddenException({ message: 'Account suspended', code: 'ACCOUNT_SUSPENDED' });
      }
      const mode: 'linked' | 'provisioned' = match ? 'linked' : 'provisioned';
      if (match) {
        if (match.user.ssoSubject !== input.subject || match.user.ssoProvider !== input.provider) {
          await db
            .update(users)
            .set({ ssoSubject: input.subject, ssoProvider: input.provider })
            .where(eq(users.id, match.user.id));
        }
        const [tfa] = await db.select().from(twoFactor).where(eq(twoFactor.userId, match.user.id));
        await this.audit.record(db, {
          orgId: input.orgId,
          actorUserId: match.user.id,
          actorEmail: match.user.email,
          action: 'auth.sso.login',
          entityType: 'user',
          entityId: match.user.id,
          newValues: { provider: input.provider, mode },
        });
        return { user: match.user, org, role: match.role, enrolled: !!tfa?.enabledAt };
      }
      const [config] = await db
        .select()
        .from(ssoConfigs)
        .where(
          and(
            eq(ssoConfigs.orgId, input.orgId),
            eq(ssoConfigs.provider, input.provider),
            eq(ssoConfigs.enabled, true),
          ),
        );
      if (!config) {
        throw new NotFoundException({
          message: `Single sign-on (${input.provider}) is not enabled for this workspace`,
          code: 'SSO_NOT_CONFIGURED',
        });
      }
      const [role] = await db
        .select()
        .from(roles)
        .where(and(eq(roles.orgId, input.orgId), eq(roles.key, config.defaultRoleKey)));
      if (!role) {
        throw new ConflictException({
          message: 'SSO default role no longer exists — ask an admin to fix the SSO config',
          code: 'SSO_ROLE_MISSING',
        });
      }
      const [created] = await db
        .insert(users)
        .values({
          orgId: input.orgId,
          email: emailLower,
          name: input.name?.trim() || emailLower.split('@')[0]!,
          passwordHash: null,
          status: 'active',
          roleId: role.id,
          ssoSubject: input.subject,
          ssoProvider: input.provider,
        })
        .returning();
      if (!created) throw new Error('Failed to provision SSO user');
      await this.audit.record(db, {
        orgId: input.orgId,
        actorUserId: created.id,
        actorEmail: created.email,
        action: 'auth.sso.login',
        entityType: 'user',
        entityId: created.id,
        newValues: {
          provider: input.provider,
          mode: 'provisioned',
          email: created.email,
          roleKey: role.key,
        },
      });
      return { user: created, org, role, enrolled: false };
    });

    const session = await this.sessions.createSession({
      userId: provisioned.user.id,
      orgId: provisioned.org.id,
      ipAddress: input.meta.ipAddress,
      userAgent: input.meta.userAgent,
      twoFactorVerified: true,
      ttlDaysOverride: provisioned.org.securitySettings.sessionTtlDays,
    });
    return {
      user: {
        ...toPublicUser(provisioned.user, provisioned.role),
        twoFactorEnrolled: provisioned.enrolled,
      },
      org: toPublicOrg(provisioned.org),
      session,
      twoFactor: { enrolled: provisioned.enrolled, required: false, verified: true },
    };
  }

  async isSsoOnly(orgId: string): Promise<boolean> {
    const [org] = await this.identityDb.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId));
    if (!org?.securitySettings.ssoOnly) return false;
    const [enabled] = await this.identityDb.db
      .select({ id: ssoConfigs.id })
      .from(ssoConfigs)
      .where(and(eq(ssoConfigs.orgId, orgId), eq(ssoConfigs.enabled, true)));
    return !!enabled;
  }

  private redact(row: SsoConfig): RedactedSsoConfig {
    const json = this.decryptConfig(row);
    const base = {
      id: row.id,
      provider: row.provider,
      enabled: row.enabled,
      domains: row.domains,
      defaultRoleKey: row.defaultRoleKey,
      updatedAt: row.updatedAt,
    };
    if (json.kind === 'oidc') {
      return { ...base, issuer: json.issuer };
    }
    return { ...base, idpSsoUrl: json.idpSsoUrl, idpEntityId: json.idpEntityId };
  }

  private async assertDefaultRole(db: NexusDb, orgId: string, roleKey: string): Promise<void> {
    const [role] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.key, roleKey)));
    if (!role || role.key === 'owner' || role.key === 'admin') {
      throw new BadRequestException({
        message: 'SSO default role must be an existing non-privileged role',
        code: 'SSO_DEFAULT_ROLE_INVALID',
      });
    }
  }

  private async assertDisablingAllowed(
    db: NexusDb,
    orgId: string,
    configId: string,
  ): Promise<void> {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    if (!org?.securitySettings.ssoOnly) return;
    const others = await db
      .select({ id: ssoConfigs.id })
      .from(ssoConfigs)
      .where(
        and(
          eq(ssoConfigs.orgId, orgId),
          eq(ssoConfigs.enabled, true),
          sql`${ssoConfigs.id} != ${configId}`,
        ),
      );
    if (others.length === 0) {
      throw new ConflictException({
        message: 'Cannot disable the last sign-on method while SSO-only is enforced',
        code: 'SSO_ONLY_LOCKOUT',
      });
    }
  }

  private async buildConfigJson(input: CreateSsoConfigInput): Promise<SsoConfigJson> {
    if (input.provider === 'oidc' && input.oidc) {
      const issuer = input.oidc.issuer.replace(/\/+$/, '');
      await this.validateOidcIssuer(issuer);
      return {
        kind: 'oidc',
        issuer,
        clientId: input.oidc.clientId,
        clientSecret: input.oidc.clientSecret,
      };
    }
    if (input.provider === 'saml' && input.saml) {
      const xml =
        input.saml.idpMetadataXml ?? (await fetchText(input.saml.idpMetadataUrl!, 500_000));
      const parsed = parseIdpMetadata(xml);
      return {
        kind: 'saml',
        ...parsed,
        emailAttribute: input.saml.emailAttribute,
        nameAttribute: input.saml.nameAttribute,
      };
    }
    throw new BadRequestException({
      message: 'Provide the matching provider block only',
      code: 'VALIDATION_ERROR',
    });
  }

  private async validateOidcIssuer(issuer: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(issuer);
    } catch {
      throw new BadRequestException({
        message: 'Issuer is not a valid URL',
        code: 'SSO_ISSUER_INVALID',
      });
    }
    if (parsed.protocol === 'http:' && !isHttpLocalhost(issuer)) {
      throw new BadRequestException({
        message: 'Issuer must use https outside local development',
        code: 'SSO_ISSUER_INVALID',
      });
    }
    if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
      throw new BadRequestException({
        message: 'Issuer must use https in production',
        code: 'SSO_ISSUER_INVALID',
      });
    }
    let doc: Record<string, unknown>;
    try {
      const text = await fetchText(`${issuer}/.well-known/openid-configuration`, 100_000);
      doc = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new BadRequestException({
        message: 'Issuer discovery document is unreachable or invalid',
        code: 'SSO_ISSUER_UNREACHABLE',
      });
    }
    const docIssuer = typeof doc['issuer'] === 'string' ? doc['issuer'].replace(/\/+$/, '') : '';
    for (const field of [
      'authorization_endpoint',
      'token_endpoint',
      'userinfo_endpoint',
      'jwks_uri',
    ] as const) {
      if (typeof doc[field] !== 'string' || !(doc[field] as string).startsWith('http')) {
        throw new BadRequestException({
          message: `Issuer discovery is missing ${field}`,
          code: 'SSO_ISSUER_INVALID',
        });
      }
    }
    if (docIssuer !== issuer) {
      throw new BadRequestException({
        message: 'Issuer mismatch in discovery document',
        code: 'SSO_ISSUER_INVALID',
      });
    }
  }
}
