import {
  createHash,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export interface MockOidcUser {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
}

/**
 * Minimal in-process OpenID Connect provider for tests: discovery, JWKS,
 * authorization endpoint, token endpoint (PKCE S256 + client_secret_basic),
 * and userinfo. Only implements what the API exercises.
 */
export class MockOidcIdP {
  readonly clientId = 'test-client';
  readonly clientSecret = 'test-secret';

  user: MockOidcUser = {
    sub: 'mock-subject-1',
    email: 'sso-user@example.test',
    emailVerified: true,
    name: 'Sam Sso',
  };
  /** When false, the authorize endpoint redirects back with access_denied. */
  allowLogin = true;
  /** Served at /saml-metadata so tests can exercise metadata-URL configs. */
  samlMetadataXml = '';

  issuer = '';
  private server: Server | null = null;
  private codes = new Map<
    string,
    { redirectUri: string; nonce: string; challenge: string; used: boolean }
  >();
  private tokens = new Map<string, { sub: string; nonce: string }>();
  private readonly kid = 'mock-key-1';
  private readonly privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  private readonly jwk: Record<string, unknown>;

  constructor() {
    this.jwk = this.privateKey.export({ format: 'jwk' }) as unknown as Record<string, unknown>;
    this.jwk['kid'] = this.kid;
    this.jwk['alg'] = 'RS256';
    this.jwk['use'] = 'sig';
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.route(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'mock_error' });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Mock IdP failed to bind');
    this.issuer = `http://127.0.0.1:${address.port}`;
    return this.issuer;
  }

  async stop(): Promise<void> {
    this.codes.clear();
    this.tokens.clear();
    if (this.server) {
      await new Promise<void>((resolve, reject) =>
        this.server!.close((err) => (err ? reject(err) : resolve())),
      );
      this.server = null;
    }
  }

  verifyIdToken(token: string): Record<string, unknown> {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) throw new Error('malformed jwt');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${h}.${p}`);
    const publicKey = this.privateKey.export({ format: 'pem', type: 'spki' }) as string;
    if (!verifier.verify(publicKey, Buffer.from(s, 'base64url'))) {
      throw new Error('bad id_token signature');
    }
    return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.issuer);
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      sendJson(res, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        userinfo_endpoint: `${this.issuer}/userinfo`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/jwks') {
      sendJson(res, 200, { keys: [this.jwk] });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/saml-metadata') {
      if (!this.samlMetadataXml) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(this.samlMetadataXml);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const params = url.searchParams;
      const redirectUri = params.get('redirect_uri') ?? '';
      const state = params.get('state') ?? '';
      if (!this.allowLogin) {
        res.writeHead(302, {
          location: `${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}`,
        });
        res.end();
        return;
      }
      if (params.get('client_id') !== this.clientId) {
        sendJson(res, 400, { error: 'invalid_client' });
        return;
      }
      const code = randomBytes(16).toString('base64url');
      this.codes.set(code, {
        redirectUri,
        nonce: params.get('nonce') ?? '',
        challenge: params.get('code_challenge') ?? '',
        used: false,
      });
      res.writeHead(302, {
        location: `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}`,
      });
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const auth = req.headers.authorization ?? '';
      const params = new URLSearchParams(await readBody(req));
      // RFC 6749 §2.3.1: credentials in Basic auth are form-encoded — decode
      // before comparing, as a real IdP does.
      let credentialsOk = false;
      const basicMatch = /^Basic (.+)$/.exec(auth);
      if (basicMatch?.[1]) {
        const decoded = Buffer.from(basicMatch[1], 'base64').toString('utf8');
        const sep = decoded.indexOf(':');
        if (sep >= 0) {
          try {
            credentialsOk =
              decodeURIComponent(decoded.slice(0, sep)) === this.clientId &&
              decodeURIComponent(decoded.slice(sep + 1)) === this.clientSecret;
          } catch {
            credentialsOk = false;
          }
        }
      }
      if (process.env.MOCK_OIDC_DEBUG === '1') {
        console.log(
          'MOCK TOKEN REQ',
          JSON.stringify({
            credentialsOk,
            grant: params.get('grant_type'),
            hasCode: !!params.get('code'),
            redirectUri: params.get('redirect_uri'),
            hasVerifier: !!params.get('code_verifier'),
          }),
        );
      }
      if (!credentialsOk) {
        sendJson(res, 401, { error: 'invalid_client' });
        return;
      }
      if (params.get('grant_type') !== 'authorization_code') {
        sendJson(res, 400, { error: 'unsupported_grant_type' });
        return;
      }
      const code = params.get('code') ?? '';
      const entry = this.codes.get(code);
      const verifier = params.get('code_verifier') ?? '';
      const challenge = base64url(createHash('sha256').update(verifier).digest());
      if (
        !entry ||
        entry.used ||
        entry.redirectUri !== (params.get('redirect_uri') ?? '') ||
        entry.challenge !== challenge
      ) {
        sendJson(res, 400, { error: 'invalid_grant' });
        return;
      }
      entry.used = true;
      const accessToken = randomBytes(24).toString('base64url');
      this.tokens.set(accessToken, { sub: this.user.sub, nonce: entry.nonce });
      const now = Math.floor(Date.now() / 1000);
      const header = base64url(JSON.stringify({ alg: 'RS256', kid: this.kid, typ: 'JWT' }));
      const payload = base64url(
        JSON.stringify({
          iss: this.issuer,
          sub: this.user.sub,
          aud: this.clientId,
          exp: now + 300,
          iat: now,
          nonce: entry.nonce,
        }),
      );
      const signer = createSign('RSA-SHA256');
      signer.update(`${header}.${payload}`);
      const signature = signer.sign(this.privateKey, 'base64url') as string;
      sendJson(res, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 300,
        id_token: `${header}.${payload}.${signature}`,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/userinfo') {
      const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
      const token = match?.[1];
      const entry = token ? this.tokens.get(token) : undefined;
      if (!entry) {
        sendJson(res, 401, { error: 'invalid_token' });
        return;
      }
      sendJson(res, 200, {
        sub: entry.sub,
        ...(this.user.email !== undefined ? { email: this.user.email } : {}),
        email_verified: this.user.emailVerified ?? false,
        ...(this.user.name !== undefined ? { name: this.user.name } : {}),
      });
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  }
}
