import { describe, expect, it } from 'vitest';
import { RTK_CAPTION_PRESETS, RTK_PRESETS } from '@weldsuite/cloudflare-realtime';
import {
  LIVEKIT_WAITING_ATTRIBUTE,
  liveKitSettings,
  mintLiveKitJoinToken,
  selectsLiveKit,
  type LiveKitSettings,
} from './livekit';

const SETTINGS: LiveKitSettings = {
  url: 'wss://lk.example.eu',
  apiKey: 'APIkey',
  apiSecret: 'a-long-enough-secret-for-hs256-signing',
  ttlSeconds: 600,
};

function decodePart(part: string): Record<string, unknown> {
  const base64 = part.replaceAll('-', '+').replaceAll('_', '/');
  return JSON.parse(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))) as Record<string, unknown>;
}

async function verifies(token: string, secret: string): Promise<boolean> {
  const [header, payload, signature] = token.split('.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const base64 = (signature ?? '').replaceAll('-', '+').replaceAll('_', '/');
  const bytes = Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  return crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(`${header}.${payload}`));
}

describe('LiveKit settings', () => {
  it('picks LiveKit by the Rust backend rule', () => {
    expect(selectsLiveKit({})).toBe(false);
    expect(selectsLiveKit({ LIVEKIT_URL: 'wss://lk' })).toBe(true);
    expect(selectsLiveKit({ VIDEO_PROVIDER: 'realtimekit', LIVEKIT_URL: 'wss://lk' })).toBe(false);
    expect(selectsLiveKit({ VIDEO_PROVIDER: 'LiveKit' })).toBe(true);
  });

  it('needs the URL and the key pair', () => {
    expect(liveKitSettings({ VIDEO_PROVIDER: 'livekit', LIVEKIT_URL: 'wss://lk' })).toBeNull();
    expect(liveKitSettings({})).toBeNull();
    expect(
      liveKitSettings({ LIVEKIT_URL: 'wss://lk', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's', LIVEKIT_TOKEN_TTL_SECONDS: '120' }),
    ).toEqual({ url: 'wss://lk', apiKey: 'k', apiSecret: 's', ttlSeconds: 120 });
  });
});

describe('mintLiveKitJoinToken', () => {
  it('mints a signed token with the claims the Rust backend writes', async () => {
    const joined = await mintLiveKitJoinToken(
      SETTINGS,
      'ws-room',
      { name: 'Gina', customParticipantId: 'guest:gina@example.com', presetName: RTK_PRESETS.GUEST, picture: 'https://img/g.png' },
      1_000,
    );
    expect(joined.participantId).toMatch(/^guest:gina@example\.com~[0-9a-f]{12}$/);
    expect(await verifies(joined.token, SETTINGS.apiSecret)).toBe(true);
    expect(await verifies(joined.token, 'another-secret')).toBe(false);
    const [header, payload] = joined.token.split('.');
    expect(decodePart(header ?? '')).toEqual({ alg: 'HS256', typ: 'JWT' });
    const claims = decodePart(payload ?? '');
    expect(claims).toMatchObject({ iss: 'APIkey', sub: joined.participantId, jti: joined.participantId, nbf: 1_000, exp: 1_600, name: 'Gina' });
    expect(claims.attributes).toEqual({ customParticipantId: 'guest:gina@example.com' });
    expect(JSON.parse(String(claims.metadata))).toEqual({ customParticipantId: 'guest:gina@example.com', picture: 'https://img/g.png' });
    expect(claims.video).toEqual({ room: 'ws-room', roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  });

  it('keeps a waiting guest from sending or receiving, and lets the host administer the room', async () => {
    const waiting = await mintLiveKitJoinToken(SETTINGS, 'ws-room', { name: 'W', customParticipantId: 'w', presetName: RTK_PRESETS.GUEST_WAITING });
    const waitingClaims = decodePart(waiting.token.split('.')[1] ?? '');
    expect(waitingClaims.video).toEqual({ room: 'ws-room', roomJoin: true, canPublish: false, canSubscribe: false, canPublishData: false });
    expect(waitingClaims.attributes).toEqual({ customParticipantId: 'w', [LIVEKIT_WAITING_ATTRIBUTE]: 'true' });

    const host = await mintLiveKitJoinToken(SETTINGS, 'ws-room', { name: 'H', customParticipantId: 'h', presetName: RTK_PRESETS.HOST });
    expect(decodePart(host.token.split('.')[1] ?? '').video).toEqual({
      room: 'ws-room', roomJoin: true, roomAdmin: true, canPublish: true, canSubscribe: true, canPublishData: true,
    });
  });

  it('treats the live-captions variant of a preset as the same role', async () => {
    const claims = async (presetName: string) =>
      decodePart((await mintLiveKitJoinToken(SETTINGS, 'ws-room', { name: 'X', customParticipantId: 'x', presetName })).token.split('.')[1] ?? '').video;
    expect(await claims(RTK_CAPTION_PRESETS.HOST)).toEqual(await claims(RTK_PRESETS.HOST));
    expect(await claims(RTK_CAPTION_PRESETS.GUEST_WAITING)).toEqual(await claims(RTK_PRESETS.GUEST_WAITING));
  });
});
