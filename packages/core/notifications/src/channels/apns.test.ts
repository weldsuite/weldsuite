import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apnsConfigFromEnv, apnsProviderToken, resetApnsTokenCache, sendApnsVoipPush, type ApnsConfig } from './apns';

const TOKEN = 'a'.repeat(64);
let config: ApnsConfig;
let publicKey: CryptoKey;

function pemFromPkcs8(der: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----`;
}

function decodeSegment(segment: string): Uint8Array {
  const binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  publicKey = pair.publicKey;
  config = {
    keyId: 'KEY123',
    teamId: 'TEAM456',
    privateKey: pemFromPkcs8((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer),
  };
});

beforeEach(() => resetApnsTokenCache());
afterEach(() => vi.unstubAllGlobals());

function stubFetch(...responses: Array<{ status: number; reason?: string }>) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift() ?? { status: 200 };
    return new Response(next.reason ? JSON.stringify({ reason: next.reason }) : null, { status: next.status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('apnsConfigFromEnv', () => {
  it('needs all three secrets', () => {
    expect(apnsConfigFromEnv({ APNS_KEY_ID: 'k', APNS_TEAM_ID: 't' })).toBeNull();
    expect(apnsConfigFromEnv({ APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_PRIVATE_KEY: 'p' })).toEqual({
      keyId: 'k',
      teamId: 't',
      privateKey: 'p',
    });
  });
});

describe('apnsProviderToken', () => {
  it('is an ES256 JWT for the key and team, verifiable with the public key', async () => {
    const jwt = await apnsProviderToken(config, 1_700_000_000_000);
    const [header, claims, signature] = jwt.split('.');

    expect(JSON.parse(new TextDecoder().decode(decodeSegment(header!)))).toEqual({ alg: 'ES256', kid: 'KEY123' });
    expect(JSON.parse(new TextDecoder().decode(decodeSegment(claims!)))).toEqual({ iss: 'TEAM456', iat: 1_700_000_000 });
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      decodeSegment(signature!),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  it('accepts a key whose newlines arrived escaped', async () => {
    const escaped = { ...config, privateKey: config.privateKey.replace(/\n/g, '\\n') };
    await expect(apnsProviderToken(escaped)).resolves.toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('reuses the token within the hour, mints a new one after 50 minutes', async () => {
    const first = await apnsProviderToken(config, 0);
    expect(await apnsProviderToken(config, 49 * 60_000)).toBe(first);
    expect(await apnsProviderToken(config, 51 * 60_000)).not.toBe(first);
  });
});

describe('sendApnsVoipPush', () => {
  const message = { deviceToken: TOKEN, topic: 'com.weldsuite.weldchat.voip', payload: { aps: {} }, expiration: 123 };

  it('sends a priority-10 VoIP push to production', async () => {
    const fetchMock = stubFetch({ status: 200 });

    expect(await sendApnsVoipPush(config, message)).toEqual({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.push.apple.com/3/device/${TOKEN}`);
    expect(init.headers).toMatchObject({
      'apns-push-type': 'voip',
      'apns-topic': 'com.weldsuite.weldchat.voip',
      'apns-priority': '10',
      'apns-expiration': '123',
    });
  });

  it('retries the sandbox for a development-build token', async () => {
    const fetchMock = stubFetch({ status: 400, reason: 'BadDeviceToken' }, { status: 200 });

    expect(await sendApnsVoipPush(config, message)).toEqual({ status: 'ok' });
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe(`https://api.sandbox.push.apple.com/3/device/${TOKEN}`);
  });

  it('reports a token dead in both environments as invalid', async () => {
    stubFetch({ status: 400, reason: 'BadDeviceToken' }, { status: 400, reason: 'BadDeviceToken' });
    expect((await sendApnsVoipPush(config, message)).status).toBe('invalid-token');
  });

  it('reports an uninstalled app as invalid without trying the sandbox', async () => {
    const fetchMock = stubFetch({ status: 410, reason: 'Unregistered' });
    expect((await sendApnsVoipPush(config, message)).status).toBe('invalid-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the token on other failures', async () => {
    stubFetch({ status: 500, reason: 'InternalServerError' });
    expect(await sendApnsVoipPush(config, message)).toEqual({ status: 'error', reason: 'InternalServerError' });
  });

  it('never calls Apple with something that is not a PushKit token', async () => {
    const fetchMock = stubFetch();
    expect((await sendApnsVoipPush(config, { ...message, deviceToken: 'ExponentPushToken[x]' })).status).toBe(
      'invalid-token',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
