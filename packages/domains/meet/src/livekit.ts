/**
 * LiveKit join tokens for servers outside the Rust backend: the meeting
 * portal's guest join on the Kubernetes editions. Same claims as the Rust
 * backend's `LiveKit` adapter (`rust/crates/video-rooms/src/livekit.rs`):
 *
 * - identity `<customParticipantId>~<nonce>`, unique per token, which is the
 *   participant id the session stores (`cfSessionId`) and LiveKit's webhook
 *   and `RemoveParticipant` use;
 * - `customParticipantId` in the attributes and the metadata, the picture in
 *   the metadata;
 * - the RealtimeKit preset decides the grants: the host preset gets
 *   `roomAdmin`, the waiting-guest preset gets nothing to send or receive and
 *   the `weldsuite.waiting` attribute until a host admits them.
 *
 * Global never calls this: its portal joins guests through RealtimeKit.
 * Signs with WebCrypto (HS256), so it runs on Node and on Workers alike.
 */

import { RTK_PRESETS } from '@weldsuite/cloudflare-realtime';

/** The participant attribute that keeps a guest in the waiting room (Rust's `WAITING_ATTRIBUTE`). */
export const LIVEKIT_WAITING_ATTRIBUTE = 'weldsuite.waiting';

export type LiveKitEnv = Record<string, string | undefined>;

export interface LiveKitSettings {
  /** The server clients connect to (`LIVEKIT_URL`, `wss://…`). */
  url: string;
  apiKey: string;
  apiSecret: string;
  /** How long a token can be used to connect (`LIVEKIT_TOKEN_TTL_SECONDS`, default 600). */
  ttlSeconds: number;
}

const value = (env: LiveKitEnv, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v ? v : undefined;
};

/**
 * Whether the environment picks LiveKit, by the Rust backend's rule:
 * `VIDEO_PROVIDER` when set, else whether `LIVEKIT_URL` is.
 */
export function selectsLiveKit(env: LiveKitEnv): boolean {
  const provider = value(env, 'VIDEO_PROVIDER')?.toLowerCase();
  if (provider) return provider === 'livekit';
  return value(env, 'LIVEKIT_URL') !== undefined;
}

/** The LiveKit settings, or null when LiveKit isn't picked or lacks its URL or key pair. */
export function liveKitSettings(env: LiveKitEnv): LiveKitSettings | null {
  if (!selectsLiveKit(env)) return null;
  const url = value(env, 'LIVEKIT_URL');
  const apiKey = value(env, 'LIVEKIT_API_KEY');
  const apiSecret = value(env, 'LIVEKIT_API_SECRET');
  if (!url || !apiKey || !apiSecret) return null;
  const ttl = Number(value(env, 'LIVEKIT_TOKEN_TTL_SECONDS'));
  return { url, apiKey, apiSecret, ttlSeconds: Number.isInteger(ttl) && ttl > 0 ? ttl : 600 };
}

export interface LiveKitParticipant {
  name: string;
  customParticipantId: string;
  /** A RealtimeKit preset name (`RTK_PRESETS`); none is a plain participant. */
  presetName?: string;
  picture?: string;
}

export interface LiveKitJoinToken {
  /** The participant id (LiveKit identity), stored as the session participant's `cfSessionId`. */
  participantId: string;
  token: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary);
  let end = base64.length;
  while (end > 0 && base64[end - 1] === '=') end -= 1;
  return base64.slice(0, end).replaceAll('+', '-').replaceAll('/', '_');
}

const encoder = new TextEncoder();
const jsonPart = (value: unknown) => base64Url(encoder.encode(JSON.stringify(value)));

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A join token for `room`, as the Rust backend's `add_participant` mints it. */
export async function mintLiveKitJoinToken(
  settings: LiveKitSettings,
  room: string,
  participant: LiveKitParticipant,
  now: number = Math.floor(Date.now() / 1000),
): Promise<LiveKitJoinToken> {
  const identity = `${participant.customParticipantId}~${randomHex(6)}`;
  const isHost = participant.presetName === RTK_PRESETS.HOST;
  const waiting = participant.presetName === RTK_PRESETS.GUEST_WAITING;
  const metadata: Record<string, string> = { customParticipantId: participant.customParticipantId };
  if (participant.picture) metadata.picture = participant.picture;
  const attributes: Record<string, string> = { customParticipantId: participant.customParticipantId };
  if (waiting) attributes[LIVEKIT_WAITING_ATTRIBUTE] = 'true';
  const claims = {
    iss: settings.apiKey,
    sub: identity,
    nbf: now,
    exp: now + settings.ttlSeconds,
    jti: identity,
    name: participant.name,
    metadata: JSON.stringify(metadata),
    attributes,
    video: {
      room,
      roomJoin: true,
      ...(isHost ? { roomAdmin: true } : {}),
      canPublish: !waiting,
      canSubscribe: !waiting,
      canPublishData: !waiting,
    },
  };
  const signingInput = `${jsonPart({ alg: 'HS256', typ: 'JWT' })}.${jsonPart(claims)}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(settings.apiSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput)));
  return { participantId: identity, token: `${signingInput}.${base64Url(signature)}` };
}
