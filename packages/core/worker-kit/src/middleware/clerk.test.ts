import { createSign, generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clerkMiddleware } from './clerk';

// Real RS256 tokens verified against a local public key (`jwtKey`), so the
// whole path runs, signature and claim checks included, with no network.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

function sign(claims: Record<string, unknown>, key = privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'ins_test' }));
  const body = b64url(
    JSON.stringify({ sub: 'user_1', sid: 'sess_1', iat: now - 5, nbf: now - 5, exp: now + 60, ...claims }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${body}`).sign(key);
  return `${header}.${body}.${b64url(signature)}`;
}

const baseEnv = { CLERK_SECRET_KEY: 'sk_test_unused', CLERK_JWT_KEY: PUBLIC_PEM };

function buildApp() {
  const app = new Hono<{ Variables: { userId: string; orgId: string | null; sessionId: string } }>();
  app.use('*', clerkMiddleware());
  app.get('/', (c) => c.json({ userId: c.get('userId'), orgId: c.get('orgId'), sessionId: c.get('sessionId') }));
  return app;
}

async function call(token: string | null, env: Record<string, string> = baseEnv) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return buildApp().request('/', { headers }, env);
}

describe('clerkMiddleware', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('rejects a request without a bearer token', async () => {
    const res = await call(null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' },
    });
  });

  it('rejects a token signed with another key', async () => {
    const res = await call(sign({ azp: 'https://app.weldsuite.org' }, otherPrivateKey));
    expect(res.status).toBe(401);
  });

  describe('authorized party (azp)', () => {
    it.each([
      'https://app.weldsuite.org',
      'https://app-test.weldsuite.org',
      'https://app-preview.weldsuite.org',
      'https://developer.weldsuite.org',
      'https://partner.weldsuite.org',
      'http://localhost:3000',
    ])('accepts a first-party token from %s', async (azp) => {
      const res = await call(sign({ azp, o: { id: 'org_1' } }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ userId: 'user_1', orgId: 'org_1', sessionId: 'sess_1' });
    });

    it('accepts a token without azp (native Expo clients send no Origin)', async () => {
      const res = await call(sign({}));
      expect(res.status).toBe(200);
    });

    it.each([
      ['an unknown origin', 'https://evil.example.com'],
      ['a welddesk.org subdomain', 'https://acme.welddesk.org'],
      ['a nested welddesk.org subdomain', 'https://a.b.welddesk.org'],
      ['a plain-http first-party host', 'http://app.weldsuite.org'],
      ['a look-alike host', 'https://app.weldsuite.org.evil.com'],
      ['an unlisted localhost port', 'http://localhost:9999'],
      ['an empty claim', ''],
    ])('refuses a token whose azp is %s', async (_label, azp) => {
      const res = await call(sign({ azp }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: { code: 'UNAUTHORIZED', message: 'Token verification failed' },
      });
    });

    it('refuses a token whose azp is not a string', async () => {
      expect((await call(sign({ azp: 42 }))).status).toBe(401);
      expect((await call(sign({ azp: ['https://app.weldsuite.org'] }))).status).toBe(401);
    });

    it('does not log the token when it refuses one', async () => {
      const token = sign({ azp: 'https://evil.example.com' });
      await call(token);
      const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
      expect(logged).toContain('https://evil.example.com');
      expect(logged).not.toContain(token);
    });
  });

  describe('CLERK_AUTHORIZED_PARTIES', () => {
    const extension = `chrome-extension://${'a'.repeat(32)}`;

    it('refuses an extension origin until it is configured', async () => {
      expect((await call(sign({ azp: extension }))).status).toBe(401);
    });

    it('accepts the configured extra origins next to the first-party list', async () => {
      const env = { ...baseEnv, CLERK_AUTHORIZED_PARTIES: `${extension}, https://weldmail.example.org` };
      expect((await call(sign({ azp: extension }), env)).status).toBe(200);
      expect((await call(sign({ azp: 'https://weldmail.example.org' }), env)).status).toBe(200);
      expect((await call(sign({ azp: 'https://app.weldsuite.org' }), env)).status).toBe(200);
      expect((await call(sign({ azp: 'https://other.example.org' }), env)).status).toBe(401);
    });

    it('ignores wildcard and path entries', async () => {
      const env = { ...baseEnv, CLERK_AUTHORIZED_PARTIES: '*, https://*.welddesk.org, https://x.example.org/app' };
      expect((await call(sign({ azp: 'https://acme.welddesk.org' }), env)).status).toBe(401);
      expect((await call(sign({ azp: 'https://*.welddesk.org' }), env)).status).toBe(401);
      expect((await call(sign({ azp: 'https://x.example.org' }), env)).status).toBe(401);
    });
  });
});
