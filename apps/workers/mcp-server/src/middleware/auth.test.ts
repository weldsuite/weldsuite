/**
 * The MCP endpoint only takes OAuth access tokens. A Clerk browser session JWT,
 * even a validly signed one from a first-party origin, is refused before any
 * workspace lookup: this is why mcp-server needs no `azp` (authorized party)
 * check of its own, unlike the session-token API workers.
 */

import { createSign, generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HonoEnv } from '../lib/api-types';
import { authMiddleware } from './auth';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

function signSessionJwt(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'ins_test' }));
  const body = b64url(
    JSON.stringify({ sub: 'user_1', sid: 'sess_1', o: { id: 'org_1' }, iat: now - 5, nbf: now - 5, exp: now + 60, ...claims }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${body}`).sign(privateKey);
  return `${header}.${body}.${b64url(signature)}`;
}

const env = {
  MCP_SERVER_URL: 'https://mcp.example.test',
  // A public test publishable key (the same one the test deploy builds with).
  CLERK_PUBLISHABLE_KEY: 'pk_test_ZGVmaW5pdGUtZWFnbGUtMy5jbGVyay5hY2NvdW50cy5kZXYk',
  CLERK_SECRET_KEY: 'sk_test_unused',
  CLERK_JWT_KEY: PUBLIC_PEM,
};

async function callMcp(token: string) {
  const app = new Hono<HonoEnv>();
  app.use('*', authMiddleware);
  app.post('/mcp', (c) => c.json({ reached: true }));
  return app.request('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, env);
}

describe('mcp-server authMiddleware', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network disabled in tests')));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['a first-party origin', 'https://app.weldsuite.org'],
    ['another frontend', 'https://acme.welddesk.org'],
    ['no authorized party', undefined],
  ])('refuses a signed session JWT from %s', async (_label, azp) => {
    const res = await callMcp(signSessionJwt(azp === undefined ? {} : { azp }));
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('token-type-mismatch');
  });
});
