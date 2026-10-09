/**
 * Online W-9 requests: the link a vendor opens to fill in their W-9.
 *
 * The link carries a random 32-byte token (base64url). Only its SHA-256 is
 * stored (`w9_requests.token_hash`); the public page finds the tenant through
 * a KV index in WORKSPACE_CACHE, `w9:<tokenHash>` -> `{ orgId, requestId }`,
 * which expires with the request and is deleted when the request is completed
 * or cancelled. The token is the credential: whoever holds the link can submit
 * the form once.
 */

import { schema } from '@weldsuite/worker-kit/db';

type RequestRow = typeof schema.w9Requests.$inferSelect;

export const W9_KV_PREFIX = 'w9:';
export const W9_DEFAULT_EXPIRY_DAYS = 30;
export const W9_MAX_EXPIRY_DAYS = 90;

export interface W9KvEntry {
  orgId: string;
  requestId: string;
}

export function w9KvKey(tokenHash: string): string {
  return `${W9_KV_PREFIX}${tokenHash}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes, base64url (43 characters). */
export function generateW9Token(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The platform page the vendor opens; set PLATFORM_URL per environment (https://app-test.weldsuite.org for test). */
export function w9Url(env: { PLATFORM_URL?: string }, token: string): string {
  const base = (env.PLATFORM_URL || 'https://app.weldsuite.org').replace(/\/+$/, '');
  return `${base}/w9/${token}`;
}

/** A pending request past its expiry reads as `expired`; the hash never leaves the server. */
export function toW9RequestView(row: RequestRow, now = new Date()) {
  const { tokenHash: _hash, ...rest } = row;
  const status = row.status === 'pending' && row.expiresAt <= now ? 'expired' : row.status;
  return { ...rest, status };
}

export function w9EventData(row: RequestRow, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: row.id,
    entityId: row.entityId,
    partyId: row.partyId,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    ...extra,
  };
}
