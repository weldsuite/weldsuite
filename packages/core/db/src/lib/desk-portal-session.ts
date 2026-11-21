/**
 * The signed-in help center's reader, from their portal session token.
 *
 * helpdesk-widget-api issues the session (`/api/portal/auth/verify`) and
 * keeps it hashed in the `WORKSPACE_CACHE` KV for 30 days
 * (`dportal:sess:<sha256 of the token>`). desk-api shares that namespace, so
 * its public help-center routes resolve the same token (forwarded by the help
 * center's server as `x-portal-session`) to the same principal, with the same
 * checks: a live session for this workspace, sign-in still on, and the
 * visitor still verified for the address the session proved (ADR DESK-010).
 */

import { asc, eq, isNull } from 'drizzle-orm';
import type { TenantDb } from './any-db';
import * as schema from '../schema';
import { deskPrincipalOf, normalizeDeskEmail, type DeskPrincipal } from './desk-portal';

type AnyDb = TenantDb;

/** The header the help center's server sends the reader's session in. */
export const DESK_PORTAL_SESSION_HEADER = 'x-portal-session';

export interface DeskPortalSession {
  workspaceId: string;
  visitorId: string;
  email: string;
  expiresAt: string;
}

/** The part of a KV namespace a session read needs. */
export interface DeskPortalSessionStore {
  get(key: string, type: 'json'): Promise<unknown>;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const deskPortalSessionKey = (tokenHash: string) => `dportal:sess:${tokenHash}`;

/** The session a token names, if it is live and for this workspace. */
export async function readDeskPortalSession(
  store: DeskPortalSessionStore | undefined,
  workspaceId: string,
  token: string,
  now: number = Date.now(),
): Promise<DeskPortalSession | null> {
  if (!store?.get || !/^[0-9a-f]{64}$/.test(token)) return null;
  const session = (await store.get(deskPortalSessionKey(await sha256Hex(token)), 'json')) as DeskPortalSession | null;
  if (!session || session.workspaceId !== workspaceId) return null;
  // An unparseable expiry counts as expired.
  const expiresAt = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return session;
}

/**
 * The principal behind a portal session token: null when the session is
 * gone, sign-in is off on this help center, or the visitor is no longer
 * verified for the session's address.
 */
export async function deskPortalPrincipal(
  db: AnyDb,
  store: DeskPortalSessionStore | undefined,
  workspaceId: string,
  token: string,
): Promise<DeskPrincipal | null> {
  const session = await readDeskPortalSession(store, workspaceId, token);
  if (!session) return null;
  const s = schema.helpcenterSettings;
  const [settings] = await db
    .select({ isEnabled: s.isEnabled, portalEnabled: s.portalEnabled })
    .from(s)
    .where(isNull(s.deletedAt))
    .orderBy(asc(s.createdAt), asc(s.id))
    .limit(1);
  if (settings?.isEnabled !== 1 || settings.portalEnabled !== 1) return null;
  const [visitor] = await db
    .select({ id: schema.deskVisitors.id, verifiedEmail: schema.deskVisitors.verifiedEmail })
    .from(schema.deskVisitors)
    .where(eq(schema.deskVisitors.id, session.visitorId))
    .limit(1);
  if (!visitor?.verifiedEmail || normalizeDeskEmail(visitor.verifiedEmail) !== session.email) return null;
  return deskPrincipalOf(visitor);
}
