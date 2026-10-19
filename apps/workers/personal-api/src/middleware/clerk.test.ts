import { createSign, generateKeyPairSync } from 'node:crypto';
import { verifyToken } from '@clerk/backend';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, Variables } from '../types';
import {
  clerkMiddleware,
  isAuthorizedParty,
  parseExtraAuthorizedParties,
  PERSONAL_AUTHORIZED_PARTIES,
} from './clerk';

// Keep the real verifier; individual tests make it throw to reach the Web
// Crypto fallback.
vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return { ...actual, verifyToken: vi.fn(actual.verifyToken) };
});

// Real RS256 tokens checked against a local public key, no network.
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

type TestEnv = Partial<Env> & { CLERK_AUTHORIZED_PARTIES?: string };
const baseEnv: TestEnv = { CLERK_SECRET_KEY: 'sk_test_unused', CLERK_JWT_KEY: PUBLIC_PEM };

async function call(token: string | null, env: TestEnv = baseEnv) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', clerkMiddleware());
  app.get('/', (c) => c.json({ userId: c.get('userId'), sessionId: c.get('sessionId') }));
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return app.request('/', { headers }, env);
}

describe('personal-api clerkMiddleware', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // A Clerk JWKS fetch (reached when the jwtKey path fails) must not hit the network.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network disabled in tests')));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rejects a request without a bearer token', async () => {
    const res = await call(null);
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with another key', async () => {
    const res = await call(sign({ azp: 'https://weldcalendar.weldsuite.org' }, otherPrivateKey));
    expect(res.status).toBe(401);
  });

  describe('authorized party (azp)', () => {
    it.each([...PERSONAL_AUTHORIZED_PARTIES])('accepts a token from %s', async (azp) => {
      const res = await call(sign({ azp }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ userId: 'user_1', sessionId: 'sess_1' });
    });

    it('accepts a token without azp (native Expo clients send no Origin)', async () => {
      const res = await call(sign({}));
      expect(res.status).toBe(200);
    });

    it.each([
      ['weldmail.com', 'https://weldmail.com'],
      ['a weldmail.com subdomain', 'https://app.weldmail.com'],
      ['the WeldMail Pages project', 'https://weldmail-web.pages.dev'],
      ['a WeldMail test Pages deployment', 'https://develop.weldmail-web-test.pages.dev'],
    ])('accepts a token whose azp is %s (WeldMail web)', async (_label, azp) => {
      expect((await call(sign({ azp }))).status).toBe(200);
    });

    it.each([
      ['an unknown origin', 'https://evil.example.com'],
      ['plain-http weldmail.com', 'http://app.weldmail.com'],
      ['two labels under weldmail.com', 'https://a.b.weldmail.com'],
      ['a weldmail.com look-alike', 'https://weldmail.com.evil.com'],
      ['another Pages project', 'https://weldmail-web-evil.pages.dev'],
      ['a welddesk.org subdomain', 'https://acme.welddesk.org'],
      ['the platform SPA, which does not call personal-api', 'https://app.weldsuite.org'],
      ['a plain-http calendar host', 'http://weldcalendar.weldsuite.org'],
      ['a look-alike host', 'https://weldcalendar.weldsuite.org.evil.com'],
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
    });

    it('enforces azp on the Web Crypto fallback too', async () => {
      // verifyToken fails twice (jwtKey, then JWKS), so the signature-only
      // fallback verifies the token; the origin check must still apply.
      const refuse = () => {
        vi.mocked(verifyToken).mockRejectedValueOnce(new Error('stale pem'));
        vi.mocked(verifyToken).mockRejectedValueOnce(new Error('jwks unreachable'));
      };

      refuse();
      const foreign = await call(sign({ azp: 'https://evil.example.com' }));
      expect(foreign.status).toBe(401);

      refuse();
      const native = await call(sign({}));
      expect(native.status).toBe(200);

      refuse();
      const calendar = await call(sign({ azp: 'https://weldcalendar.weldsuite.org' }));
      expect(calendar.status).toBe(200);
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
    it('accepts the configured WeldMail web origins on top of the built-in list', async () => {
      const env = { ...baseEnv, CLERK_AUTHORIZED_PARTIES: 'https://mail.example.org, https://mail-test.example.org' };
      expect((await call(sign({ azp: 'https://mail.example.org' }), env)).status).toBe(200);
      expect((await call(sign({ azp: 'https://weldcalendar.weldsuite.org' }), env)).status).toBe(200);
      expect((await call(sign({ azp: 'https://mail.example.org' }))).status).toBe(401);
    });

    it('ignores wildcard and path entries', async () => {
      const env = { ...baseEnv, CLERK_AUTHORIZED_PARTIES: '*, https://*.example.org, https://mail.example.org/app' };
      expect((await call(sign({ azp: 'https://mail.example.org' }), env)).status).toBe(401);
      expect((await call(sign({ azp: 'https://any.example.org' }), env)).status).toBe(401);
    });
  });
});

describe('isAuthorizedParty / parseExtraAuthorizedParties', () => {
  it('treats a missing claim as native and a malformed one as foreign', () => {
    expect(isAuthorizedParty(undefined)).toBe(true);
    expect(isAuthorizedParty(null)).toBe(true);
    expect(isAuthorizedParty('')).toBe(false);
    expect(isAuthorizedParty(1)).toBe(false);
    expect(isAuthorizedParty('https://weldcalendar.weldsuite.org/')).toBe(false);
  });

  it('parses only exact origins', () => {
    expect(parseExtraAuthorizedParties(undefined)).toEqual([]);
    expect(
      parseExtraAuthorizedParties('https://A.example.org, *, https://b.example.org/x, chrome-extension://short'),
    ).toEqual(['https://a.example.org']);
  });
});
