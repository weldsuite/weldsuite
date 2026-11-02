/**
 * Visitor tokens (issued here) and identity tokens (signed by the customer's
 * server): what each accepts and refuses.
 */

import { describe, expect, it } from 'vitest';
import { signJwt, verifyJwt, base64Url } from './tokens';
import {
  identitySecretFingerprint,
  IDENTITY_TOKEN_MAX_TTL_SECONDS,
  issueVisitorToken,
  readVisitorToken,
  requiresIdentity,
  verifyIdentityToken,
} from './visitor-identity';

const WORKER_SECRET = 'worker-secret-for-tests';
const WIDGET_SECRET = 'widget-identity-secret';
const now = () => Math.floor(Date.now() / 1000);

describe('visitor tokens', () => {
  const scope = { visitorId: 'dvis_1', workspaceId: 'ws_1', widgetId: 'widget_1' };

  it('round-trips the visitor, workspace and widget', async () => {
    const token = await issueVisitorToken(WORKER_SECRET, scope);
    expect(await readVisitorToken(WORKER_SECRET, token)).toEqual(scope);
  });

  it('refuses a token signed with another secret', async () => {
    const token = await issueVisitorToken('another-secret', scope);
    expect(await readVisitorToken(WORKER_SECRET, token)).toBeNull();
  });

  it('refuses an edited token', async () => {
    const token = await issueVisitorToken(WORKER_SECRET, scope);
    const [header, , signature] = token.split('.');
    const forged = base64Url(JSON.stringify({ aud: 'desk-visitor', sub: 'dvis_other', ws: 'ws_1', wid: 'widget_1', exp: now() + 60 }));
    expect(await readVisitorToken(WORKER_SECRET, `${header}.${forged}.${signature}`)).toBeNull();
  });

  it('is not signed with the realtime secret itself, so realtime-worker never takes one', async () => {
    const token = await issueVisitorToken(WORKER_SECRET, scope);
    expect(await verifyJwt(WORKER_SECRET, token)).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses an expired token', async () => {
    const token = await issueVisitorToken(WORKER_SECRET, scope, now() - 400 * 24 * 60 * 60);
    expect(await readVisitorToken(WORKER_SECRET, token)).toBeNull();
  });
});

describe('identity tokens', () => {
  it('accepts sub, email and name, and lower-cases the email', async () => {
    const exp = now() + 3600;
    const token = await signJwt(WIDGET_SECRET, { sub: 'user-42', email: ' Ada@Example.com ', name: 'Ada', exp });
    expect(await verifyIdentityToken(WIDGET_SECRET, token)).toEqual({
      ok: true,
      identity: { externalId: 'user-42', email: 'ada@example.com', name: 'Ada', expiresAt: exp },
    });
  });

  it('takes a numeric user id', async () => {
    const exp = now() + 60;
    const token = await signJwt(WIDGET_SECRET, { sub: 42, exp });
    const result = await verifyIdentityToken(WIDGET_SECRET, token);
    expect(result.ok && result.identity).toEqual({ externalId: '42', email: null, name: null, expiresAt: exp });
  });

  it('refuses a token signed with another secret', async () => {
    const token = await signJwt('not-the-widget-secret', { sub: 'user-42', exp: now() + 60 });
    expect(await verifyIdentityToken(WIDGET_SECRET, token)).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses alg none', async () => {
    const header = base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const body = base64Url(JSON.stringify({ sub: 'user-42', exp: now() + 60 }));
    expect(await verifyIdentityToken(WIDGET_SECRET, `${header}.${body}.`)).toMatchObject({ ok: false });
  });

  it('needs sub and exp, and exp at most 30 days out', async () => {
    for (const claims of [
      { exp: now() + 60 },
      { sub: 'user-42' },
      { sub: 'user-42', exp: now() + IDENTITY_TOKEN_MAX_TTL_SECONDS + 3600 },
    ]) {
      const token = await signJwt(WIDGET_SECRET, claims);
      expect(await verifyIdentityToken(WIDGET_SECRET, token)).toEqual({ ok: false, reason: 'claims' });
    }
  });

  it('refuses an expired token and a malformed email', async () => {
    const expired = await signJwt(WIDGET_SECRET, { sub: 'u', exp: now() - 3600 });
    expect(await verifyIdentityToken(WIDGET_SECRET, expired)).toEqual({ ok: false, reason: 'expired' });
    const badEmail = await signJwt(WIDGET_SECRET, { sub: 'u', email: 'not-an-email', exp: now() + 60 });
    expect(await verifyIdentityToken(WIDGET_SECRET, badEmail)).toEqual({ ok: false, reason: 'claims' });
  });
});

describe('visitor tokens for identified visitors', () => {
  const scope = { visitorId: 'dvis_2', workspaceId: 'ws_1', widgetId: 'widget_1' };

  it('carry the secret fingerprint and expire no later than asked', async () => {
    const expiresAt = now() + 120;
    const token = await issueVisitorToken(WORKER_SECRET, { ...scope, secretFingerprint: 'fp_1', expiresAt });
    expect(await readVisitorToken(WORKER_SECRET, token)).toEqual({ ...scope, secretFingerprint: 'fp_1' });
    const expired = await issueVisitorToken(WORKER_SECRET, { ...scope, expiresAt: now() - 3600 });
    expect(await readVisitorToken(WORKER_SECRET, expired)).toBeNull();
  });

  it('fingerprint a secret stably, and differently per secret', async () => {
    expect(await identitySecretFingerprint('a')).toBe(await identitySecretFingerprint('a'));
    expect(await identitySecretFingerprint('a')).not.toBe(await identitySecretFingerprint('b'));
  });
});

describe('requiresIdentity', () => {
  it('only with a secret set', () => {
    expect(requiresIdentity({ identitySecret: 's', identityRequired: true })).toBe(true);
    expect(requiresIdentity({ identitySecret: null, identityRequired: true })).toBe(false);
    expect(requiresIdentity({ identitySecret: 's', identityRequired: false })).toBe(false);
  });
});
