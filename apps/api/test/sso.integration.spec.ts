import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { inviteAndAccept, loginAgent } from './helpers';
import { MockOidcIdP } from './mock-oidc-idp';
import { createMockSamlIdP, signSamlResponse } from './mock-saml-idp';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5432/nexus';

function redirectOf(res: request.Response): string {
  expect(res.status).toBe(302);
  const location = res.headers['location'] as string;
  expect(location).toBeDefined();
  return location;
}

function errorCodeOf(location: string): string {
  return new URL(location).searchParams.get('code') ?? '';
}

function parseSamlRequest(redirectUrl: string): {
  relayState: string;
  requestId: string;
  issuer: string;
  acsUrl: string;
  destination: string;
} {
  const url = new URL(redirectUrl);
  const relayState = url.searchParams.get('RelayState') ?? '';
  const encoded = url.searchParams.get('SAMLRequest') ?? '';
  expect(encoded.length).toBeGreaterThan(0);
  const xml = inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8');
  const requestId = /<samlp:AuthnRequest[^>]*\sID="([^"]+)"/.exec(xml)?.[1] ?? '';
  const issuer = /<saml:Issuer[^>]*>([^<]+)<\/saml:Issuer>/.exec(xml)?.[1] ?? '';
  const acsUrl = /AssertionConsumerServiceURL="([^"]+)"/.exec(xml)?.[1] ?? '';
  const destination = /Destination="([^"]+)"/.exec(xml)?.[1] ?? '';
  expect(requestId).not.toBe('');
  expect(relayState).not.toBe('');
  return { relayState, requestId, issuer, acsUrl, destination };
}

describe('sso (oidc + saml)', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@sso.test`;

  let app: INestApplication;
  let server: Server;
  let db: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let oidcOrgSlug: string;
  let samlOrgSlug: string;
  let oidcConfigId: string;
  let samlConfigId: string;

  const oidcIdp = new MockOidcIdP();
  let samlIdp: Awaited<ReturnType<typeof createMockSamlIdP>>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    db = new Pool({ connectionString: AUTH_DATABASE_URL });
    await oidcIdp.start();
    samlIdp = await createMockSamlIdP();

    const signup = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `SSO ${runId}`,
        name: 'Sofia Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    oidcOrgSlug = signup.body.org.slug as string;
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    const samlSignup = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `SSO SAML ${runId}`,
        name: 'Sofia Owner',
        email: email('saml-owner'),
        password: 'correct-horse-12',
      });
    orgIds.push(samlSignup.body.org.id as string);
    samlOrgSlug = samlSignup.body.org.slug as string;
  });

  afterAll(async () => {
    await oidcIdp.stop();
    for (const id of orgIds) {
      await db.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await db.end();
    await app.close();
  });

  async function oidcFlow(userEmail?: string): Promise<{
    callbackLocation: string;
    cookie: string;
  }> {
    const start = await request(server).get(`/v1/auth/sso/oidc/${oidcOrgSlug}/start`);
    const authorizeUrl = redirectOf(start);
    expect(authorizeUrl.startsWith(`${oidcIdp.issuer}/authorize`)).toBe(true);
    const authorizeParams = new URL(authorizeUrl).searchParams;
    expect(authorizeParams.get('client_id')).toBe('test-client');
    expect(authorizeParams.get('code_challenge_method')).toBe('S256');

    if (userEmail) {
      oidcIdp.user = { ...oidcIdp.user, email: userEmail, sub: `sub-${userEmail}` };
    }
    const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(authorizeRes.status).toBe(302);
    const idpRedirect = authorizeRes.headers.get('location') ?? '';
    expect(idpRedirect).toContain('/oidc/');
    const params = new URL(idpRedirect).searchParams;

    const callback = await request(server).get(
      `/v1/auth/sso/oidc/${oidcOrgSlug}/callback?code=${params.get('code')}&state=${params.get('state')}`,
    );
    const location = redirectOf(callback);
    const cookies = (callback.headers['set-cookie'] ?? []) as unknown as string[];
    return { callbackLocation: location, cookie: cookies.join(';') };
  }

  async function samlPost(
    relayState: string,
    samlResponse: string,
  ): Promise<{ location: string; cookie: string }> {
    const res = await request(server)
      .post(`/v1/auth/sso/saml/${samlOrgSlug}/acs`)
      .type('form')
      .send({ SAMLResponse: samlResponse, RelayState: relayState });
    const location = redirectOf(res);
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    return { location, cookie: cookies.join(';') };
  }

  it('creates an OIDC config after validating the issuer, redacting secrets', async () => {
    const bad = await ownerAgent.post('/v1/sso/configs').send({
      provider: 'oidc',
      oidc: { issuer: 'https://idp.invalid.test', clientId: 'x', clientSecret: 'y' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('SSO_ISSUER_UNREACHABLE');

    const insecure = await ownerAgent.post('/v1/sso/configs').send({
      provider: 'oidc',
      oidc: { issuer: 'http://idp.invalid.test', clientId: 'x', clientSecret: 'y' },
    });
    expect(insecure.status).toBe(400);

    const created = await ownerAgent.post('/v1/sso/configs').send({
      provider: 'oidc',
      domains: ['example.test'],
      oidc: { issuer: oidcIdp.issuer, clientId: 'test-client', clientSecret: 'test-secret' },
    });
    expect(created.status).toBe(201);
    expect(created.body.enabled).toBe(false);
    expect(created.body.issuer).toBe(oidcIdp.issuer);
    expect(JSON.stringify(created.body)).not.toContain('test-secret');
    oidcConfigId = created.body.id as string;

    const dupe = await ownerAgent.post('/v1/sso/configs').send({
      provider: 'oidc',
      oidc: { issuer: oidcIdp.issuer, clientId: 'a', clientSecret: 'b' },
    });
    expect(dupe.status).toBe(409);
    expect(dupe.body.code).toBe('SSO_CONFIG_EXISTS');

    const listed = await ownerAgent.get('/v1/sso/configs');
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);

    const enable = await ownerAgent
      .patch(`/v1/sso/configs/${oidcConfigId}`)
      .send({ enabled: true });
    expect(enable.status).toBe(200);
    expect(enable.body.enabled).toBe(true);
  });

  it('forbids SSO config management without org:manage', async () => {
    const rep = await inviteAndAccept(server, ownerAgent, {
      email: email('sso-rep'),
      roleKey: 'rep',
      name: 'Rita Rep',
    });
    const repAgent = await loginAgent(server, email('sso-rep'), 'member-pass-12');
    expect(rep.id).toBeDefined();
    const forbidden = await repAgent.post('/v1/sso/configs').send({
      provider: 'oidc',
      oidc: { issuer: oidcIdp.issuer, clientId: 'a', clientSecret: 'b' },
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('SCOPE_FORBIDDEN');
  });

  it('rejects SSO login start for unknown orgs and unconfigured providers', async () => {
    const unknown = await request(server).get('/v1/auth/sso/oidc/no-such-org/start');
    expect(errorCodeOf(redirectOf(unknown))).toBe('start_failed');
    const unconfigured = await request(server).get(`/v1/auth/sso/saml/${oidcOrgSlug}/start`);
    expect(errorCodeOf(redirectOf(unconfigured))).toBe('start_failed');
  });

  it('completes an OIDC login, provisioning the user with the default role', async () => {
    const { callbackLocation, cookie } = await oidcFlow(email('oidc-user'));
    expect(new URL(callbackLocation).pathname).toBe('/sso/success');
    expect(cookie).toMatch(/nx_session=/);

    const me = await request(server).get('/v1/auth/me').set('Cookie', cookie.split(';')[0]!);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email('oidc-user'));
    expect(me.body.user.name).toBe('Sam Sso');
    expect(me.body.user.role.key).toBe('rep');

    const second = await oidcFlow(email('oidc-user'));
    expect(new URL(second.callbackLocation).pathname).toBe('/sso/success');
    const directory = await ownerAgent.get('/v1/users');
    const matches = directory.body.filter((u: { email: string }) => u.email === email('oidc-user'));
    expect(matches).toHaveLength(1);
  });

  it('rejects OIDC logins with unverified emails and denies IdP errors', async () => {
    oidcIdp.user = {
      sub: 'mock-subject-unverified',
      email: email('oidc-unverified'),
      emailVerified: false,
      name: 'Unverified U',
    };
    const { callbackLocation } = await oidcFlow(email('oidc-unverified'));
    expect(errorCodeOf(callbackLocation)).toBe('email_not_verified');
    oidcIdp.user = {
      sub: 'mock-subject-1',
      email: 'sso-user@example.test',
      emailVerified: true,
      name: 'Sam Sso',
    };

    oidcIdp.allowLogin = false;
    const start = await request(server).get(`/v1/auth/sso/oidc/${oidcOrgSlug}/start`);
    const authorizeRes = await fetch(redirectOf(start), { redirect: 'manual' });
    const denied = new URL(authorizeRes.headers.get('location') ?? '');
    const deniedCallback = await request(server).get(
      `/v1/auth/sso/oidc/${oidcOrgSlug}/callback?error=${denied.searchParams.get('error')}&state=${denied.searchParams.get('state')}`,
    );
    expect(errorCodeOf(redirectOf(deniedCallback))).toBe('access_denied');
    oidcIdp.allowLogin = true;
  });

  it('rejects reused OIDC authorization codes and states', async () => {
    const start = await request(server).get(`/v1/auth/sso/oidc/${oidcOrgSlug}/start`);
    const authorizeRes = await fetch(redirectOf(start), { redirect: 'manual' });
    const params = new URL(authorizeRes.headers.get('location') ?? '').searchParams;
    const first = await request(server).get(
      `/v1/auth/sso/oidc/${oidcOrgSlug}/callback?code=${params.get('code')}&state=${params.get('state')}`,
    );
    expect(new URL(redirectOf(first)).pathname).toBe('/sso/success');
    const replay = await request(server).get(
      `/v1/auth/sso/oidc/${oidcOrgSlug}/callback?code=${params.get('code')}&state=${params.get('state')}`,
    );
    expect(errorCodeOf(redirectOf(replay))).toBe('invalid_session');
  });

  it('resolves workspaces by email domain', async () => {
    const found = await request(server).get('/v1/auth/sso/resolve?email=jane@example.test');
    expect(found.status).toBe(200);
    expect(found.body.orgs).toHaveLength(1);
    expect(found.body.orgs[0].providers).toEqual(['oidc']);

    const missing = await request(server).get('/v1/auth/sso/resolve?email=jane@unknown.test');
    expect(missing.body.orgs).toEqual([]);
  });

  it('creates a SAML config from IdP metadata XML and serves it redacted', async () => {
    const samlOwner = await loginAgent(server, email('saml-owner'), 'correct-horse-12');
    const garbage = await samlOwner.post('/v1/sso/configs').send({
      provider: 'saml',
      saml: { idpMetadataXml: '<not-xml' },
    });
    expect(garbage.status).toBe(400);

    const created = await samlOwner.post('/v1/sso/configs').send({
      provider: 'saml',
      domains: ['saml.test'],
      saml: { idpMetadataXml: samlIdp.metadataXml() },
    });
    expect(created.status).toBe(201);
    expect(created.body.idpEntityId).toBe(samlIdp.entityId);
    expect(created.body.idpSsoUrl).toBe(samlIdp.ssoUrl);
    expect(JSON.stringify(created.body)).not.toContain('BEGIN CERTIFICATE');
    samlConfigId = created.body.id as string;

    const enable = await samlOwner.patch(`/v1/sso/configs/${samlConfigId}`).send({ enabled: true });
    expect(enable.body.enabled).toBe(true);
  });

  it('fetches SAML metadata from a URL when XML is not pasted', async () => {
    oidcIdp.samlMetadataXml = samlIdp.metadataXml();
    const fresh = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `SSO Meta ${runId}`,
        name: 'M',
        email: email('meta-owner'),
        password: 'correct-horse-12',
      });
    orgIds.push(fresh.body.org.id as string);
    const metaAgent = await loginAgent(server, email('meta-owner'), 'correct-horse-12');
    const created = await metaAgent.post('/v1/sso/configs').send({
      provider: 'saml',
      saml: { idpMetadataUrl: `${oidcIdp.issuer}/saml-metadata` },
    });
    expect(created.status).toBe(201);
    expect(created.body.idpEntityId).toBe(samlIdp.entityId);

    const missing = await metaAgent.post('/v1/sso/configs').send({
      provider: 'oidc',
      oidc: { issuer: `${oidcIdp.issuer}/nope`, clientId: 'a', clientSecret: 'b' },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('SSO_ISSUER_UNREACHABLE');
  });

  it('starts a SAML login with a well-formed AuthnRequest bound to a state row', async () => {
    const start = await request(server).get(`/v1/auth/sso/saml/${samlOrgSlug}/start`);
    const location = redirectOf(start);
    expect(location.startsWith(`${samlIdp.ssoUrl}?SAMLRequest=`)).toBe(true);
    const parsed = parseSamlRequest(location);
    expect(parsed.destination).toBe(samlIdp.ssoUrl);
    expect(parsed.issuer).toContain(`/v1/auth/sso/saml/${samlOrgSlug}`);
    expect(parsed.acsUrl).toContain(`/v1/auth/sso/saml/${samlOrgSlug}/acs`);

    const { rows } = await db.query(
      'SELECT saml_request_id FROM sso_login_states ORDER BY created_at DESC LIMIT 1',
    );
    expect(rows[0].saml_request_id).toBe(parsed.requestId);
  });

  it('completes a SAML login from a signed assertion', async () => {
    const start = await request(server).get(`/v1/auth/sso/saml/${samlOrgSlug}/start`);
    const parsed = parseSamlRequest(redirectOf(start));
    const samlResponse = signSamlResponse(samlIdp, {
      spEntityId: parsed.issuer,
      acsUrl: parsed.acsUrl,
      requestId: parsed.requestId,
      email: email('saml-user'),
      name: 'Sally Saml',
    });
    const { location, cookie } = await samlPost(parsed.relayState, samlResponse);
    expect(new URL(location).pathname).toBe('/sso/success');

    const me = await request(server).get('/v1/auth/me').set('Cookie', cookie.split(';')[0]!);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email('saml-user'));
    expect(me.body.user.name).toBe('Sally Saml');

    const replay = await samlPost(parsed.relayState, samlResponse);
    expect(errorCodeOf(replay.location)).toBe('invalid_session');
  });

  it('rejects tampered, unsigned, wrong-audience, and expired SAML responses', async () => {
    async function attempt(
      mutate: (idp: typeof samlIdp, base: Parameters<typeof signSamlResponse>[1]) => string,
    ): Promise<string> {
      const start = await request(server).get(`/v1/auth/sso/saml/${samlOrgSlug}/start`);
      const parsed = parseSamlRequest(redirectOf(start));
      const samlResponse = mutate(samlIdp, {
        spEntityId: parsed.issuer,
        acsUrl: parsed.acsUrl,
        requestId: parsed.requestId,
      });
      return errorCodeOf((await samlPost(parsed.relayState, samlResponse)).location);
    }

    expect(
      await attempt((idp, base) => signSamlResponse(idp, { ...base, tamperAfterSign: true })),
    ).toBe('login_failed');
    expect(
      await attempt((idp, base) => signSamlResponse(idp, { ...base, signAssertion: false })),
    ).toBe('login_failed');
    expect(
      await attempt((idp, base) =>
        signSamlResponse(idp, { ...base, audienceOverride: 'https://evil.test/sp' }),
      ),
    ).toBe('login_failed');
    expect(
      await attempt((idp, base) =>
        signSamlResponse(idp, { ...base, notOnOrAfterMs: -300_000, notBeforeMs: -600_000 }),
      ),
    ).toBe('login_failed');
  });

  it('falls back to NameID for email and reports a missing email explicitly', async () => {
    const start = await request(server).get(`/v1/auth/sso/saml/${samlOrgSlug}/start`);
    const parsed = parseSamlRequest(redirectOf(start));
    const fallback = signSamlResponse(samlIdp, {
      spEntityId: parsed.issuer,
      acsUrl: parsed.acsUrl,
      requestId: parsed.requestId,
      email: email('saml-nameid'),
      omitEmailAttribute: true,
    });
    const ok = await samlPost(parsed.relayState, fallback);
    expect(new URL(ok.location).pathname).toBe('/sso/success');

    const start2 = await request(server).get(`/v1/auth/sso/saml/${samlOrgSlug}/start`);
    const parsed2 = parseSamlRequest(redirectOf(start2));
    const missing = signSamlResponse(samlIdp, {
      spEntityId: parsed2.issuer,
      acsUrl: parsed2.acsUrl,
      requestId: parsed2.requestId,
      omitEmailAttribute: true,
      omitNameIdEmail: true,
    });
    const bad = await samlPost(parsed2.relayState, missing);
    expect(errorCodeOf(bad.location)).toBe('email_not_found');
  });

  it('enforces SSO-only: password login blocked, guards against lockout', async () => {
    const fresh = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `SSO Only ${runId}`,
        name: 'O',
        email: email('sso-only'),
        password: 'correct-horse-12',
      });
    orgIds.push(fresh.body.org.id as string);
    const freshAgent = await loginAgent(server, email('sso-only'), 'correct-horse-12');

    const premature = await freshAgent.patch('/v1/org/security').send({ ssoOnly: true });
    expect(premature.status).toBe(409);
    expect(premature.body.code).toBe('SSO_ONLY_NO_PROVIDER');

    const config = await freshAgent.post('/v1/sso/configs').send({
      provider: 'oidc',
      oidc: { issuer: oidcIdp.issuer, clientId: 'test-client', clientSecret: 'test-secret' },
    });
    expect(config.status).toBe(201);
    await freshAgent.patch(`/v1/sso/configs/${config.body.id as string}`).send({ enabled: true });

    const enforced = await freshAgent.patch('/v1/org/security').send({ ssoOnly: true });
    expect(enforced.status).toBe(200);

    const blocked = await request(server)
      .post('/v1/auth/login')
      .send({ email: email('sso-only'), password: 'correct-horse-12' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('SSO_REQUIRED');

    const disableLast = await freshAgent
      .patch(`/v1/sso/configs/${config.body.id as string}`)
      .send({ enabled: false });
    expect(disableLast.status).toBe(409);
    expect(disableLast.body.code).toBe('SSO_ONLY_LOCKOUT');

    const removeLast = await freshAgent.delete(`/v1/sso/configs/${config.body.id as string}`);
    expect(removeLast.status).toBe(409);

    const relaxed = await freshAgent.patch('/v1/org/security').send({ ssoOnly: false });
    expect(relaxed.status).toBe(200);
    const allowed = await request(server)
      .post('/v1/auth/login')
      .send({ email: email('sso-only'), password: 'correct-horse-12' });
    expect(allowed.status).toBe(200);
  });
});
