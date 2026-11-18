/**
 * A small OpenID provider for the sign-in tests and for trying the Node build
 * locally: discovery, an authorization endpoint that signs in one configured
 * person without asking, a token endpoint that checks the client secret, the
 * redirect URI and PKCE, RS256 ID tokens, userinfo (with Zitadel's
 * resource-owner claim when its scope is asked for) and end-session. Plain
 * HTTP on 127.0.0.1. Not for anything but tests.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakePerson {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  /** The organization the account belongs to, as Zitadel's resource-owner claim. */
  org?: string;
}

export interface FakeProviderOptions {
  clientId: string;
  clientSecret: string;
  person: FakePerson;
}

interface Grant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
  scope: string;
}

export interface FakeProvider {
  issuer: string;
  /** Who signs in at the authorization endpoint; tests change it between runs. */
  person: FakePerson;
  /** Faults to inject: a wrong nonce in the ID token, another subject at userinfo. */
  faults: { nonce?: string; userinfoSub?: string };
  /** Sign in at the authorization URL the console built; returns the callback URL. */
  authorize(authorizationUrl: string): string;
  close(): Promise<void>;
}

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url');

async function sha256(value: string): Promise<string> {
  return base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

export async function startFakeProvider(options: FakeProviderOptions, port = 0): Promise<FakeProvider> {
  const keys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

  const grants = new Map<string, Grant>();
  const tokens = new Map<string, { person: FakePerson; scope: string }>();
  let issuer = '';

  async function idToken(person: FakePerson, grant: Grant): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' })));
    const claims = {
      iss: issuer,
      sub: person.sub,
      aud: grant.clientId,
      azp: grant.clientId,
      iat: now,
      exp: now + 300,
      nonce: provider.faults.nonce ?? grant.nonce,
    };
    const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${header}.${payload}`));
    return `${header}.${payload}.${base64url(signature)}`;
  }

  const authorize = (authorizationUrl: string): string => {
    const url = new URL(authorizationUrl);
    const q = url.searchParams;
    if (q.get('client_id') !== options.clientId) throw new Error('unknown client');
    if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256') throw new Error('bad request');
    const code = crypto.randomUUID();
    grants.set(code, {
      clientId: q.get('client_id')!,
      redirectUri: q.get('redirect_uri')!,
      challenge: q.get('code_challenge')!,
      nonce: q.get('nonce')!,
      scope: q.get('scope') ?? '',
    });
    const callback = new URL(q.get('redirect_uri')!);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', q.get('state')!);
    callback.searchParams.set('iss', issuer);
    return callback.href;
  };

  type Answer = { status: number; value?: unknown; location?: string };
  const json = (status: number, value: unknown): Answer => ({ status, value });

  const discovery = (): Answer =>
    json(200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/keys`,
      end_session_endpoint: `${issuer}/end_session`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
    });

  /** The code for tokens: the client secret, the redirect URI and PKCE must all match. */
  async function token(req: IncomingMessage): Promise<Answer> {
    const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
    const [id, secret] = basic.split(':').map(decodeURIComponent);
    if (id !== options.clientId || secret !== options.clientSecret) return json(401, { error: 'invalid_client' });
    const form = new URLSearchParams(await body(req));
    const grant = grants.get(form.get('code') ?? '');
    grants.delete(form.get('code') ?? '');
    const valid =
      form.get('grant_type') === 'authorization_code' &&
      grant !== undefined &&
      form.get('redirect_uri') === grant.redirectUri &&
      (await sha256(form.get('code_verifier') ?? '')) === grant.challenge;
    if (!valid) return json(400, { error: 'invalid_grant' });
    const accessToken = crypto.randomUUID();
    tokens.set(accessToken, { person: provider.person, scope: grant.scope });
    return json(200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 300,
      id_token: await idToken(provider.person, grant),
    });
  }

  function userinfo(req: IncomingMessage): Answer {
    const token = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!token) return json(401, { error: 'invalid_token' });
    const { person, scope } = token;
    const withOrg = person.org && scope.split(' ').includes('urn:zitadel:iam:user:resourceowner');
    return json(200, {
      sub: provider.faults.userinfoSub ?? person.sub,
      email: person.email,
      email_verified: person.emailVerified,
      name: person.name,
      ...(withOrg ? { 'urn:zitadel:iam:user:resourceowner:id': person.org } : {}),
    });
  }

  async function handle(req: IncomingMessage): Promise<Answer> {
    const url = new URL(req.url ?? '/', issuer);
    switch (url.pathname) {
      case '/.well-known/openid-configuration':
        return discovery();
      case '/keys':
        return json(200, { keys: [jwk] });
      case '/authorize':
        return { status: 302, location: authorize(url.href) };
      case '/end_session':
        return { status: 302, location: url.searchParams.get('post_logout_redirect_uri') ?? issuer };
      case '/token':
        return req.method === 'POST' ? token(req) : json(405, { error: 'method_not_allowed' });
      case '/userinfo':
        return userinfo(req);
      default:
        return json(404, { error: 'not_found' });
    }
  }

  const server: Server = createServer((req, res) => {
    handle(req).then(
      (out) => {
        if (out.location) {
          res.writeHead(out.status, { Location: out.location }).end();
          return;
        }
        res.writeHead(out.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(out.value));
      },
      () => res.writeHead(500).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const provider: FakeProvider = {
    issuer,
    person: options.person,
    faults: {},
    authorize,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return provider;
}
