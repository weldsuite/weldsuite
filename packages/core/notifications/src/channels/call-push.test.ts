import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetApnsTokenCache } from './apns';
import { callTokenDeviceId, isCallToken, sendCallRing, type DeviceTokenRow } from './call-push';
import type { NotificationEnv } from '../types';

const VOIP = 'b'.repeat(64);
const EXPO = 'ExponentPushToken[android-1]';
let env: NotificationEnv;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  env = {
    APNS_KEY_ID: 'KEY',
    APNS_TEAM_ID: 'TEAM',
    APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))}\n-----END PRIVATE KEY-----`,
  } as NotificationEnv;
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetApnsTokenCache();
});

const rows: DeviceTokenRow[] = [
  { deviceId: 'ios_1', token: 'ExponentPushToken[ios-1]', tokenType: 'expo', appCode: 'weldchat' },
  { deviceId: 'ios_1:call', token: VOIP, tokenType: 'voip', appCode: 'weldchat' },
  { deviceId: 'android_1', token: EXPO, tokenType: 'expo', appCode: 'weldchat' },
  { deviceId: 'android_1:call', token: EXPO, tokenType: 'expo_call', appCode: 'weldchat' },
];

const ringData = { entityId: 'call_1', chatChannelId: 'ch_1', callType: 'voice', callerName: 'Alice' };

/** Apple and Expo both accept; records what each was sent. */
function stubPushServices() {
  const apple: Array<{ url: string; body: unknown }> = [];
  const expo: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as unknown;
      if (url.includes('push.apple.com')) {
        apple.push({ url, body });
        return new Response(null, { status: 200 });
      }
      expo.push(...(body as unknown[]));
      return Response.json({ data: (body as unknown[]).map(() => ({ status: 'ok', id: 't' })) });
    }),
  );
  return { apple, expo };
}

describe('call tokens', () => {
  it('are the voip and expo_call rows, keyed to their device', () => {
    expect(rows.map(isCallToken)).toEqual([false, true, false, true]);
    expect(callTokenDeviceId('ios_1:call')).toBe('ios_1');
    expect(callTokenDeviceId('ios_1')).toBe('ios_1');
  });
});

describe('sendCallRing', () => {
  it('rings iOS through CallKit and Android with a data-only push', async () => {
    const { apple, expo } = stubPushServices();

    const result = await sendCallRing(env, rows, ringData);

    expect([...result.deliveredDeviceIds].sort()).toEqual(['android_1', 'ios_1']);
    expect(apple).toHaveLength(1);
    expect(apple[0]?.url).toContain(VOIP);
    expect(apple[0]?.body).toMatchObject({
      aps: {},
      weldchat: { notificationType: 'chat_call_ring', callId: 'call_1', callerName: 'Alice' },
    });
    // Only the expo_call row; never the device's ordinary Expo row.
    expect(expo).toHaveLength(1);
    expect(expo[0]).toMatchObject({ to: EXPO, priority: 'high', data: { notificationType: 'chat_call_ring' } });
    expect(expo[0]).not.toHaveProperty('title');
    expect(expo[0]).not.toHaveProperty('body');
  });

  it('leaves iPhones to the banner when there is no APNs key', async () => {
    const { apple } = stubPushServices();

    const result = await sendCallRing({} as NotificationEnv, rows, ringData);

    expect(apple).toHaveLength(0);
    expect([...result.deliveredDeviceIds]).toEqual(['android_1']);
  });

  it('reports dead VoIP tokens and does not count their device as rung', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) =>
        url.includes('push.apple.com')
          ? new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 })
          : Response.json({ data: (JSON.parse(String(init.body)) as unknown[]).map(() => ({ status: 'ok' })) }),
      ),
    );

    const result = await sendCallRing(env, rows, ringData);

    expect(result.invalidTokens).toEqual([VOIP]);
    expect(result.deliveredDeviceIds.has('ios_1')).toBe(false);
  });
});
