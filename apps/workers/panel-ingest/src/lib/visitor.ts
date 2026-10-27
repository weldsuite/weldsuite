/**
 * The cookieless visitor id (ADR PANEL-006): until a visitor consents the
 * browser stores nothing, so the collector derives an id from what every
 * request carries,
 *
 *   ck_ + first 24 hex of SHA-256(salt : projectId : ip : userAgent)
 *
 * The salt is random, per UTC day, and deleted after a day or two (PanelSalt),
 * so the same visitor gets a new id every day, the id cannot be linked across
 * days and cannot be recomputed from an IP and a user agent later. The project
 * is in the hash so one visitor on two projects is not linkable either.
 */

import type { PanelSalt } from '../durable-objects/panel-salt';
import { utcDate } from './time';

/** Prefix of every cookieless id; ids a browser sends with consent never use it. */
export const COOKIELESS_PREFIX = 'ck_';

const GLOBAL_SALT = 'global';

let cached: { date: string; salt: string } | null = null;
let inflight: { date: string; promise: Promise<string> } | null = null;

/**
 * Today's salt (UTC). Cached per isolate for the date, with concurrent first
 * requests sharing one call, so PanelSalt sees about one call per isolate per day.
 */
export async function todaysSalt(namespace: DurableObjectNamespace<PanelSalt>, now: number): Promise<string> {
  const date = utcDate(now);
  if (cached?.date === date) return cached.salt;
  if (inflight?.date === date) return inflight.promise;

  const promise = namespace
    .get(namespace.idFromName(GLOBAL_SALT))
    .today()
    .then((result) => {
      cached = result;
      return result.salt;
    })
    .finally(() => {
      inflight = null;
    });
  inflight = { date, promise };
  return promise;
}

/** Forgets the cached salt. Tests only: an isolate keeps it for the day. */
export function resetSaltCache(): void {
  cached = null;
  inflight = null;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function cookielessVisitorId(
  salt: string,
  projectId: string,
  ip: string,
  userAgent: string,
): Promise<string> {
  const input = new TextEncoder().encode(`${salt}:${projectId}:${ip}:${userAgent}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return COOKIELESS_PREFIX + hex(digest).slice(0, 24);
}
