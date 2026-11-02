/**
 * What a LiveKit join token says about its holder. The meet API mints it
 * (`rust/crates/video-rooms/src/livekit.rs`, and the meeting portal's
 * `lib/livekit.ts` for guests); the client only reads it, to know who it is
 * before it connects and what it may do.
 */

import { trimTrailingSlashes } from '../video-provider';

/** Participant attribute that keeps a guest in the waiting room (`WAITING_ATTRIBUTE` in Rust). */
export const WAITING_ATTRIBUTE = 'weldsuite.waiting';
/** Participant attribute with our id for them (the WeldSuite user id or guest id). */
export const CUSTOM_ID_ATTRIBUTE = 'customParticipantId';

export interface LiveKitTokenClaims {
  identity: string;
  name?: string;
  room?: string;
  /** May administer the room (the meeting's host): admit, mute, remove. */
  roomAdmin: boolean;
  canPublish: boolean;
  attributes: Record<string, string>;
  metadata: Record<string, unknown>;
}

function base64UrlDecode(part: string): string {
  const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(record(value))) {
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

/** The parts of a token's metadata JSON (`{"customParticipantId","picture"}`). */
export function parseMetadata(metadata: string | undefined | null): Record<string, unknown> {
  if (!metadata) return {};
  try {
    return record(JSON.parse(metadata));
  } catch {
    return {};
  }
}

/** Decodes (does not verify: the server does) a LiveKit access token. */
export function readLiveKitToken(token: string): LiveKitTokenClaims {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('Not a LiveKit access token');
  const claims = record(JSON.parse(base64UrlDecode(payload)));
  const video = record(claims.video);
  const identity = typeof claims.sub === 'string' ? claims.sub : '';
  if (!identity) throw new Error('The LiveKit access token names no participant');
  return {
    identity,
    name: typeof claims.name === 'string' ? claims.name : undefined,
    room: typeof video.room === 'string' ? video.room : undefined,
    roomAdmin: video.roomAdmin === true,
    canPublish: video.canPublish !== false,
    attributes: stringRecord(claims.attributes),
    metadata: parseMetadata(typeof claims.metadata === 'string' ? claims.metadata : undefined),
  };
}

/** The HTTP base of a LiveKit server for its `RoomService` API. */
export function liveKitApiBase(url: string): string {
  const trimmed = trimTrailingSlashes(url.trim());
  if (trimmed.startsWith('wss://')) return `https://${trimmed.slice('wss://'.length)}`;
  if (trimmed.startsWith('ws://')) return `http://${trimmed.slice('ws://'.length)}`;
  return trimmed;
}
