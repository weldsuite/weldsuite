/**
 * A softphone credential per member (`desk_phone_agents`).
 *
 * An inbound call can only ring one person when that person's browser is
 * signed in with a credential of its own: the server then dials
 * `sip:<sipUsername>@sip.telnyx.com` and only that credential's browsers ring.
 * (`POST /api/call-intelligence/token` keeps minting from the one credential
 * every member of every workspace shares, for outbound calls.)
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  TelnyxApiError,
  telnyxCreateCredential,
  telnyxCredentialToken,
  telnyxDeleteCredential,
  type TelnyxEnv,
} from '../lib/telnyx';

/** Telnyx resource ids are UUIDs; anything outside this shape must not reach a request path. */
const TELNYX_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const CREDENTIAL_NAME_MAX = 64;

export interface SoftphoneState {
  /** Telnyx key and SIP connection are set. */
  configured: boolean;
  available: boolean;
  /** The member has a credential. */
  registered: boolean;
  sipUsername: string | null;
}

export function softphoneConfigured(env: TelnyxEnv): boolean {
  return Boolean(env.TELNYX_API_KEY && env.TELNYX_SIP_CONNECTION_ID);
}

export async function getSoftphone(env: TelnyxEnv, db: Database, userId: string): Promise<SoftphoneState> {
  const a = schema.deskPhoneAgents;
  const [row] = await db.select().from(a).where(eq(a.userId, userId)).limit(1);
  return {
    configured: softphoneConfigured(env),
    available: row?.available ?? false,
    registered: Boolean(row?.telnyxCredentialId && row.sipUsername),
    sipUsername: row?.sipUsername ?? null,
  };
}

/** The member's "take calls" switch; creates their row on first use. */
export async function setSoftphoneAvailable(
  env: TelnyxEnv,
  db: Database,
  userId: string,
  available: boolean,
): Promise<SoftphoneState> {
  const a = schema.deskPhoneAgents;
  await db
    .insert(a)
    .values({ userId, available })
    .onConflictDoUpdate({ target: a.userId, set: { available, updatedAt: new Date() } });
  return getSoftphone(env, db, userId);
}

/** `weldsuite-desk-<workspace id>-<user id>`, cut to a length and alphabet Telnyx takes. */
export function credentialName(workspaceId: string, userId: string): string {
  return `weldsuite-desk-${workspaceId}-${userId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, CREDENTIAL_NAME_MAX);
}

/**
 * Create the member's credential and store it, unless another request stored
 * one first (two tabs asking at once): then ours is deleted and theirs used.
 * `staleId` is the stored credential Telnyx no longer knows, replaced here.
 */
async function createAndStoreCredential(
  env: TelnyxEnv,
  db: Database,
  args: { workspaceId: string; userId: string; staleId: string | null },
): Promise<{ id: string; sipUsername: string }> {
  const connectionId = env.TELNYX_SIP_CONNECTION_ID;
  if (!connectionId) throw new Error('TELNYX_SIP_CONNECTION_ID is not set');
  const created = await telnyxCreateCredential(env, {
    connectionId,
    name: credentialName(args.workspaceId, args.userId),
  });
  if (!TELNYX_ID_RE.test(created.id)) throw new Error('Unexpected Telnyx credential id format');

  const a = schema.deskPhoneAgents;
  await db.insert(a).values({ userId: args.userId }).onConflictDoNothing();
  const [claimed] = await db
    .update(a)
    .set({ telnyxCredentialId: created.id, sipUsername: created.sipUsername, updatedAt: new Date() })
    .where(
      and(
        eq(a.userId, args.userId),
        args.staleId ? eq(a.telnyxCredentialId, args.staleId) : isNull(a.telnyxCredentialId),
      ),
    )
    .returning({ id: a.telnyxCredentialId, sipUsername: a.sipUsername });
  if (claimed?.id && claimed.sipUsername) return { id: claimed.id, sipUsername: claimed.sipUsername };

  try {
    await telnyxDeleteCredential(env, created.id);
  } catch (err) {
    console.warn('[desk-phone] could not delete an unused softphone credential:', err);
  }
  const [row] = await db.select().from(a).where(eq(a.userId, args.userId)).limit(1);
  if (!row?.telnyxCredentialId || !row.sipUsername) throw new Error('Softphone credential was not stored');
  return { id: row.telnyxCredentialId, sipUsername: row.sipUsername };
}

/**
 * A login token from the member's own credential, created on first use. When
 * Telnyx no longer knows the stored credential (404) a new one is created, once.
 */
export async function mintSoftphoneToken(
  env: TelnyxEnv,
  db: Database,
  args: { workspaceId: string; userId: string },
): Promise<{ token: string; sipUsername: string }> {
  const a = schema.deskPhoneAgents;
  const [row] = await db.select().from(a).where(eq(a.userId, args.userId)).limit(1);
  let credential =
    row?.telnyxCredentialId && row.sipUsername
      ? { id: row.telnyxCredentialId, sipUsername: row.sipUsername }
      : await createAndStoreCredential(env, db, { ...args, staleId: null });

  try {
    return { token: await telnyxCredentialToken(env, credential.id), sipUsername: credential.sipUsername };
  } catch (err) {
    if (!(err instanceof TelnyxApiError) || err.status !== 404) throw err;
    credential = await createAndStoreCredential(env, db, { ...args, staleId: credential.id });
    return { token: await telnyxCredentialToken(env, credential.id), sipUsername: credential.sipUsername };
  }
}
