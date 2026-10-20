import { createSign, generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clerkJwtAuth } from './auth';

// Real RS256 tokens checked against a local public key, no network.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

function sign(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ sub: 'user_1', iat: now - 5, exp: now + 60, ...claims }));
  const signature = createSign('RSA-SHA256').update(`${header}.${body}`).sign(privateKey);
  return `${header}.${body}.${b64url(signature)}`;
}

async function call(token: string, extraEnv: Record<string, string> = {}) {
  const app = new Hono<{ Variables: { userId: string; orgId: string | null; orgRole: string | null } }>();
  app.use('*', clerkJwtAuth());
  app.get('/', (c) => c.json({ userId: c.get('userId'), orgId: c.get('orgId') }));
  return app.request(
    '/',
    { headers: { Authorization: `Bearer ${token}` } },
    { CLERK_JWT_KEY: PUBLIC_PEM, ...extraEnv },
  );
}

describe('billing-worker clerkJwtAuth', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['https://app.weldsuite.org', 'https://developer.weldsuite.org', 'http://localhost:3000'])(
    'accepts a first-party token from %s',
    async (azp) => {
      const res = await call(sign({ azp, o: { id: 'org_1' } }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ userId: 'user_1', orgId: 'org_1' });
    },
  );

  it('accepts a token without azp (native clients forwarded by app-api)', async () => {
    expect((await call(sign({}))).status).toBe(200);
  });

  it.each([
    'https://evil.example.com',
    'https://acme.welddesk.org',
    'http://app.weldsuite.org',
    'https://app.weldsuite.org.evil.com',
    '',
  ])('refuses a token whose azp is %j', async (azp) => {
    const res = await call(sign({ azp }));
    expect(res.status).toBe(401);
  });

  it('accepts an extra origin configured in CLERK_AUTHORIZED_PARTIES', async () => {
    const azp = `chrome-extension://${'b'.repeat(32)}`;
    expect((await call(sign({ azp }))).status).toBe(401);
    expect((await call(sign({ azp }), { CLERK_AUTHORIZED_PARTIES: azp })).status).toBe(200);
  });
});
