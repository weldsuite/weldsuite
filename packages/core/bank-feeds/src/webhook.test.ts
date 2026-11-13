import { describe, expect, it } from 'vitest';
import { WebhookVerificationError } from './errors';
import { sha256Hex } from './normalize';
import { bytesToBase64Url, routeFetch } from './test-utils';
import { utf8 } from './http';
import {
  buildStripeSignatureHeader,
  createIbanityKeyResolver,
  createPlaidKeyResolver,
  memoryKeyCache,
  sha512Base64,
  timingSafeEqual,
  verifyIbanityWebhook,
  verifyPlaidWebhook,
  verifyStripeSignature,
  type IbanityWebhookKey,
  type PlaidWebhookKey,
} from './webhook';
import { ibanityTestKey, ibanityToken } from './ibanity-test-utils';

describe('Ibanity (Ponto) webhook', () => {
  const body = JSON.stringify({ data: { type: 'pontoConnect.account.transactionsCreated', id: 'evt_1' } });
  const now = 1_800_000_000_000;
  const at = now / 1000;

  it('accepts an RS512 token for this application whose digest matches the body', async () => {
    const { privateKey, jwk } = await ibanityTestKey('kid-1');
    const header = await ibanityToken(privateKey, 'kid-1', { aud: 'app-1', digest: await sha512Base64(body), iat: at, exp: at + 60 });
    await expect(verifyIbanityWebhook({ body, header, applicationId: 'app-1', getKey: async () => jwk, now })).resolves.toBeUndefined();
    // Ibanity pads its keys' base64url; that reads too.
    const padded = { ...jwk, n: `${jwk.n}=` };
    await expect(verifyIbanityWebhook({ body, header, applicationId: 'app-1', getKey: async () => padded, now })).resolves.toBeUndefined();
  });

  it('refuses another audience or issuer, an expired or future token, a changed body, another key or algorithm', async () => {
    const { privateKey, jwk } = await ibanityTestKey('kid-1');
    const other = await ibanityTestKey('kid-1');
    const good = { aud: 'app-1', digest: await sha512Base64(body), iat: at, exp: at + 60 };
    const cases: Array<[string | null, string]> = [
      [null, 'Missing Signature header'],
      ['not.a', 'Malformed webhook token'],
      [await ibanityToken(privateKey, 'kid-1', { ...good, aud: 'app-2' }), 'Webhook token for another application'],
      [await ibanityToken(privateKey, 'kid-1', { ...good, iss: 'https://evil.example' }), 'Webhook token from another issuer'],
      [await ibanityToken(privateKey, 'kid-1', { ...good, exp: at - 31 }), 'Webhook token expired'],
      [await ibanityToken(privateKey, 'kid-1', { ...good, iat: at + 31 }), 'Webhook token issued in the future'],
      [await ibanityToken(privateKey, 'kid-1', { ...good, digest: await sha512Base64('{}') }), 'Webhook body does not match its token'],
      [await ibanityToken(other.privateKey, 'kid-1', good), 'Invalid webhook signature'],
      [await ibanityToken(privateKey, 'kid-1', good, 'RS256'), 'Unsupported webhook token'],
    ];
    for (const [header, message] of cases) {
      await expect(verifyIbanityWebhook({ body, header, applicationId: 'app-1', getKey: async () => jwk, now })).rejects.toThrow(message);
    }
    // Within the 30 seconds' leeway, and an audience list naming the application.
    const lenient = await ibanityToken(privateKey, 'kid-1', { ...good, aud: ['other', 'app-1'], exp: at - 30, iat: at + 30 });
    await expect(verifyIbanityWebhook({ body, header: lenient, applicationId: 'app-1', getKey: async () => jwk, now })).resolves.toBeUndefined();
    const unavailable = async (): Promise<IbanityWebhookKey> => {
      throw new Error('down');
    };
    await expect(
      verifyIbanityWebhook({ body, header: await ibanityToken(privateKey, 'kid-1', good), applicationId: 'app-1', getKey: unavailable, now }),
    ).rejects.toThrow('Webhook verification key unavailable');
  });

  it('resolves keys from /webhooks/keys once an hour, by kid, signing keys only', async () => {
    let clock = 1_000;
    const cache = memoryKeyCache(() => clock);
    const key = (kid: string, use = 'sig') => ({ alg: 'RS512', e: 'AQAB', kid, kty: 'RSA', n: `n-${kid}`, status: 'ACTIVE', use });
    const { fetch, calls } = routeFetch({ 'GET /webhooks/keys': { keys: [key('kid-1'), key('kid-enc', 'enc')] } });
    const getKey = createIbanityKeyResolver({ applicationId: 'app-1', cache, fetchImpl: fetch });

    expect(await getKey('kid-1')).toEqual({ e: 'AQAB', kid: 'kid-1', kty: 'RSA', n: 'n-kid-1' });
    expect(await getKey('kid-1')).toEqual({ e: 'AQAB', kid: 'kid-1', kty: 'RSA', n: 'n-kid-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.ibanity.com/webhooks/keys');
    expect(calls[0]?.headers.accept).toBe('application/vnd.api+json');
    expect(await cache.get('bank-feeds:ibanity-wk:app-1:kid-1')).toBe('{"e":"AQAB","kid":"kid-1","kty":"RSA","n":"n-kid-1"}');

    await expect(getKey('kid-enc')).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(getKey('kid-unknown')).rejects.toBeInstanceOf(WebhookVerificationError);

    clock += 3_700_000; // past the hour TTL
    await getKey('kid-1');
    expect(calls).toHaveLength(4);
  });
});

describe('timingSafeEqual', () => {
  it('compares strings of any length', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('Stripe signature', () => {
  const secret = 'whsec_test_secret';
  const payload = JSON.stringify({ id: 'evt_1', type: 'financial_connections.account.refreshed_transactions' });
  const now = 1_800_000_000_000;

  it('accepts a fresh, correctly signed delivery', async () => {
    const header = await buildStripeSignatureHeader(payload, secret, now / 1000);
    expect(await verifyStripeSignature({ payload, header, secret, now })).toBe(true);
  });

  it('accepts when any v1 candidate matches (secret rotation)', async () => {
    const good = await buildStripeSignatureHeader(payload, secret, now / 1000);
    const header = `${good},v1=${'0'.repeat(64)}`;
    expect(await verifyStripeSignature({ payload, header, secret, now })).toBe(true);
  });

  it('rejects a wrong secret, a tampered body and a missing header', async () => {
    const header = await buildStripeSignatureHeader(payload, secret, now / 1000);
    expect(await verifyStripeSignature({ payload, header, secret: 'whsec_other', now })).toBe(false);
    expect(await verifyStripeSignature({ payload: `${payload} `, header, secret, now })).toBe(false);
    expect(await verifyStripeSignature({ payload, header: null, secret, now })).toBe(false);
    expect(await verifyStripeSignature({ payload, header: 'garbage', secret, now })).toBe(false);
  });

  it('rejects outside the five minute tolerance', async () => {
    const header = await buildStripeSignatureHeader(payload, secret, now / 1000 - 301);
    expect(await verifyStripeSignature({ payload, header, secret, now })).toBe(false);
    const recent = await buildStripeSignatureHeader(payload, secret, now / 1000 - 299);
    expect(await verifyStripeSignature({ payload, header: recent, secret, now })).toBe(true);
  });
});

async function plaidFixture() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const key: PlaidWebhookKey = {
    alg: 'ES256',
    crv: 'P-256',
    kid: 'kid-1',
    kty: 'EC',
    use: 'sig',
    x: jwk.x ?? '',
    y: jwk.y ?? '',
    created_at: 1_700_000_000,
    expired_at: null,
  };

  async function sign(body: string, overrides: { iat?: number; kid?: string; hash?: string; alg?: string } = {}) {
    const header = bytesToBase64Url(utf8(JSON.stringify({ alg: overrides.alg ?? 'ES256', kid: overrides.kid ?? 'kid-1', typ: 'JWT' })));
    const claims = bytesToBase64Url(
      utf8(JSON.stringify({ iat: overrides.iat ?? 1_800_000_000, request_body_sha256: overrides.hash ?? (await sha256Hex(body)) })),
    );
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, utf8(`${header}.${claims}`));
    return `${header}.${claims}.${bytesToBase64Url(new Uint8Array(signature))}`;
  }

  return { key, sign, getKey: async () => key };
}

describe('Plaid webhook verification', () => {
  const body = JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item_1' });
  const now = 1_800_000_100_000;

  it('accepts a signed delivery whose body hash matches', async () => {
    const { sign, getKey } = await plaidFixture();
    await expect(verifyPlaidWebhook({ body, header: await sign(body), getKey, now })).resolves.toBeUndefined();
  });

  it('rejects a tampered body', async () => {
    const { sign, getKey } = await plaidFixture();
    const header = await sign(body);
    await expect(verifyPlaidWebhook({ body: `${body} `, header, getKey, now })).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('rejects a token older than five minutes', async () => {
    const { sign, getKey } = await plaidFixture();
    const header = await sign(body, { iat: 1_800_000_000 - 400 });
    await expect(verifyPlaidWebhook({ body, header, getKey, now })).rejects.toThrow(/expired/);
  });

  it('rejects a signature from another key', async () => {
    const real = await plaidFixture();
    const attacker = await plaidFixture();
    await expect(verifyPlaidWebhook({ body, header: await attacker.sign(body), getKey: real.getKey, now })).rejects.toThrow(/signature/);
  });

  it('rejects non-ES256 tokens, missing headers and expired keys', async () => {
    const { sign, getKey, key } = await plaidFixture();
    await expect(verifyPlaidWebhook({ body, header: await sign(body, { alg: 'HS256' }), getKey, now })).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(verifyPlaidWebhook({ body, header: null, getKey, now })).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(
      verifyPlaidWebhook({ body, header: await sign(body), getKey: async () => ({ ...key, expired_at: 1_700_000_001 }), now }),
    ).rejects.toThrow(/key expired/);
  });

  it('rejects a token whose claimed body hash differs', async () => {
    const { sign, getKey } = await plaidFixture();
    const header = await sign(body, { hash: 'f'.repeat(64) });
    await expect(verifyPlaidWebhook({ body, header, getKey, now })).rejects.toThrow(/body does not match/);
  });
});

describe('Plaid key resolver', () => {
  it('fetches the key once and serves the cache afterwards', async () => {
    let clock = 1_000;
    const cache = memoryKeyCache(() => clock);
    const { fetch, calls } = routeFetch({
      'POST /webhook_verification_key/get': { key: { alg: 'ES256', crv: 'P-256', kid: 'kid-1', kty: 'EC', use: 'sig', x: 'xx', y: 'yy', created_at: 1, expired_at: null } },
    });
    const getKey = createPlaidKeyResolver({ baseUrl: 'https://sandbox.plaid.com', clientId: 'cid', secret: 'sec', cache, fetchImpl: fetch });

    expect((await getKey('kid-1')).x).toBe('xx');
    expect((await getKey('kid-1')).y).toBe('yy');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({ client_id: 'cid', secret: 'sec', key_id: 'kid-1' });

    clock += 3_700_000; // past the hour TTL
    await getKey('kid-1');
    expect(calls).toHaveLength(2);
  });
});
