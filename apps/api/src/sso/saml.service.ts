import { Inject, Injectable, Logger } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';
import { eq } from 'drizzle-orm';
import { ssoLoginStates } from '@nexus/db';
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';
import { IdentityDb } from '../database/tenant-db.service';
import { SsoService } from './sso.service';
import type { SamlConfigJson } from './sso.schemas';

const responseParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function extractInResponseTo(rawResponse: string): string | null {
  let xml: string;
  try {
    xml = Buffer.from(rawResponse, 'base64').toString('utf8');
  } catch {
    return null;
  }
  try {
    const doc = responseParser.parse(xml) as Record<string, unknown>;
    const rootKey = Object.keys(doc).find((k) => k === 'Response' || k.endsWith(':Response'));
    const root = (rootKey ? doc[rootKey] : undefined) as Record<string, unknown> | undefined;
    const value = root?.['@_InResponseTo'];
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function profileString(profile: Profile, key: string): string | undefined {
  const value = profile[key];
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim().length > 0) {
    return (value[0] as string).trim();
  }
  return undefined;
}

@Injectable()
export class SamlService {
  private readonly logger = new Logger(SamlService.name);

  constructor(
    @Inject(SsoService) private readonly sso: SsoService,
    @Inject(IdentityDb) private readonly identityDb: IdentityDb,
  ) {}

  private buildSaml(orgSlug: string, json: SamlConfigJson, cache: CacheProvider): SAML {
    return new SAML({
      callbackUrl: this.sso.samlAcsUrl(orgSlug),
      entryPoint: json.idpSsoUrl,
      issuer: this.sso.samlEntityId(orgSlug),
      idpCert: json.idpCert,
      idpIssuer: json.idpEntityId,
      audience: this.sso.samlEntityId(orgSlug),
      acceptedClockSkewMs: 120_000,
      maxAssertionAgeMs: 600_000,
      validateInResponseTo: ValidateInResponseTo.always,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      cacheProvider: cache,
      authnRequestBinding: 'HTTP-Redirect',
    });
  }

  /**
   * Request-ID cache backed by sso_login_states so outstanding logins survive
   * restarts and work across instances. node-saml's cache protocol stores an
   * instant string per request ID and enforces requestIdExpirationPeriodMs on
   * read — getAsync therefore returns the row's created_at, not its id.
   */
  private startCache(rowId: string): CacheProvider {
    return {
      saveAsync: async (key: string): Promise<null> => {
        await this.identityDb.db
          .update(ssoLoginStates)
          .set({ samlRequestId: key })
          .where(eq(ssoLoginStates.id, rowId));
        return null;
      },
      getAsync: async (key: string): Promise<string | null> => this.stampForRequestId(key),
      removeAsync: async (key: string): Promise<string | null> => this.clearRequestId(key),
    };
  }

  private acsCache(): CacheProvider {
    return {
      saveAsync: async (): Promise<null> => null,
      getAsync: async (key: string): Promise<string | null> => this.stampForRequestId(key),
      removeAsync: async (key: string): Promise<string | null> => this.clearRequestId(key),
    };
  }

  private async stampForRequestId(requestId: string): Promise<string | null> {
    const [row] = await this.identityDb.db
      .select({ createdAt: ssoLoginStates.createdAt })
      .from(ssoLoginStates)
      .where(eq(ssoLoginStates.samlRequestId, requestId));
    return row ? row.createdAt.toISOString() : null;
  }

  private async clearRequestId(requestId: string): Promise<string | null> {
    const [row] = await this.identityDb.db
      .select({ id: ssoLoginStates.id, createdAt: ssoLoginStates.createdAt })
      .from(ssoLoginStates)
      .where(eq(ssoLoginStates.samlRequestId, requestId));
    if (!row) return null;
    await this.identityDb.db
      .update(ssoLoginStates)
      .set({ samlRequestId: null })
      .where(eq(ssoLoginStates.id, row.id));
    return row.createdAt.toISOString();
  }

  async startLogin(orgSlug: string): Promise<string> {
    const org = await this.sso.orgBySlug(orgSlug);
    const row = await this.sso.enabledConfig(org.id, 'saml');
    const json = this.sso.decryptConfig(row);
    if (json.kind !== 'saml') throw new Error('SSO config kind mismatch');
    const { state, rowId } = await this.sso.createStateRow({ orgId: org.id, provider: 'saml' });
    const saml = this.buildSaml(org.slug, json, this.startCache(rowId));
    return saml.getAuthorizeUrlAsync(state, undefined, {});
  }

  async handleAcs(
    orgSlug: string,
    body: Record<string, string | undefined>,
    meta: { ipAddress?: string; userAgent?: string },
  ): Promise<{ redirect: string; cookie?: { token: string; expiresAt: Date } }> {
    const samlResponse = body['SAMLResponse'];
    const relayState = body['RelayState'];
    if (!samlResponse || !relayState) {
      return { redirect: this.sso.errorRedirect('missing_parameters') };
    }
    let consumed;
    try {
      consumed = await this.sso.consumeStateRow('saml', relayState);
    } catch {
      return { redirect: this.sso.errorRedirect('invalid_session') };
    }
    const inResponseTo = extractInResponseTo(samlResponse);
    if (!inResponseTo || inResponseTo !== consumed.samlRequestId) {
      return { redirect: this.sso.errorRedirect('request_mismatch') };
    }
    const org = await this.sso.orgBySlug(orgSlug);
    if (org.id !== consumed.orgId) {
      return { redirect: this.sso.errorRedirect('organization_mismatch') };
    }
    let configRow;
    try {
      configRow = await this.sso.enabledConfig(org.id, 'saml');
    } catch {
      return { redirect: this.sso.errorRedirect('misconfigured') };
    }
    const json = this.sso.decryptConfig(configRow);
    if (json.kind !== 'saml') {
      return { redirect: this.sso.errorRedirect('misconfigured') };
    }
    const saml = this.buildSaml(org.slug, json, this.acsCache());
    let profile: Profile | null;
    try {
      ({ profile } = await saml.validatePostResponseAsync({
        SAMLResponse: samlResponse,
        RelayState: relayState,
      }));
    } catch (err) {
      this.logger.warn(
        `SAML response validation failed for org ${org.slug}: ${(err as Error).message}`,
      );
      return { redirect: this.sso.errorRedirect('login_failed') };
    }
    if (!profile) {
      return { redirect: this.sso.errorRedirect('login_failed') };
    }
    const email = profileString(profile, json.emailAttribute) ?? this.nameIdEmail(profile);
    if (!email) {
      return { redirect: this.sso.errorRedirect('email_not_found') };
    }
    const name =
      (json.nameAttribute ? profileString(profile, json.nameAttribute) : undefined) ??
      profileString(profile, 'displayName') ??
      profileString(profile, 'fullName') ??
      undefined;
    const subject =
      typeof profile.nameID === 'string' && profile.nameID.length > 0 ? profile.nameID : email;
    try {
      const result = await this.sso.provisionOrLinkAndIssue({
        orgId: org.id,
        provider: 'saml',
        subject,
        email,
        name,
        meta,
      });
      return {
        redirect: this.sso.successRedirect(),
        cookie: { token: result.session.token, expiresAt: result.session.expiresAt },
      };
    } catch (err) {
      this.logger.warn(`SAML provisioning failed for org ${org.slug}: ${(err as Error).message}`);
      if ((err as { status?: number }).status === 403) {
        return { redirect: this.sso.errorRedirect('account_suspended') };
      }
      return { redirect: this.sso.errorRedirect('login_failed') };
    }
  }

  private nameIdEmail(profile: Profile): string | undefined {
    if (typeof profile.nameID === 'string' && profile.nameID.includes('@')) {
      return profile.nameID.trim();
    }
    return undefined;
  }
}
