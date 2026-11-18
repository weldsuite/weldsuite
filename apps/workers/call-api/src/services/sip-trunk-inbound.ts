/**
 * A call that arrives over a customer's own phone system (SIP trunk / PBX).
 *
 * The trunk is its own Telnyx connection with call parking on, so the call
 * reaches the Telnyx webhook as `call.initiated` without a client_state, like
 * a call to one of our numbers, but on a connection that is neither
 * TELNYX_CONNECTION_ID nor TELNYX_SIP_CONNECTION_ID. Telnyx calls what a
 * connection originates "outbound", so the payload's `direction` is no guide.
 *
 * A call to a trunk's number is let in only when that trunk exists, is active
 * and owns the connection the call came in on; otherwise it is refused and,
 * when a trunk can be identified, the reason is kept on it. That holds for
 * every way such a call could reach us, not only over a trunk: the trunk's
 * connection is what authenticates the sender.
 *
 * A number we host takes a call from a phone system only when that phone
 * system is the destination workspace's own (a colleague dialling the support
 * number from their desk phone), or the connection is the number's own: then
 * it is an ordinary inbound call to that number. Any other trunk's call to it
 * is refused, so one workspace cannot run its calls (and their minutes) into
 * another's number.
 *
 * A trunk's SIP login is in a customer's hands, so a `client_state` on an
 * event of a trunk connection proves nothing by itself: the workspace it names
 * must own that connection (`ownsTrunkConnection`).
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { TelnyxEnv } from '../lib/telnyx';
import type { PhoneNumberRow } from './desk-phone-inbound';

type TrunkRow = typeof schema.voipSipTrunks.$inferSelect;

export type TrunkAdmission = { ok: true; trunk: TrunkRow } | { ok: false; reason: string };

/**
 * Whether an event's payload came in over a customer's trunk: it names a
 * connection that is not one of ours. Without TELNYX_CONNECTION_ID there is
 * nothing to tell ours from theirs, so nothing counts as a trunk call.
 */
export function isTrunkCall(env: TelnyxEnv, payload: Record<string, unknown>): boolean {
  if (!env.TELNYX_CONNECTION_ID) return false;
  const connectionId = payload.connection_id;
  if (typeof connectionId !== 'string' || connectionId === '') return false;
  return connectionId !== env.TELNYX_CONNECTION_ID && connectionId !== env.TELNYX_SIP_CONNECTION_ID;
}

async function recordError(db: Database, trunkId: string, message: string, now: Date): Promise<void> {
  await db
    .update(schema.voipSipTrunks)
    .set({ lastError: message, updatedAt: now })
    .where(eq(schema.voipSipTrunks.id, trunkId));
}

/**
 * Decide whether a call to `phoneRow`, a number of a trunk (`sipTrunkId` set),
 * may continue; a refusal is kept on a trunk as `lastError`.
 */
export async function admitTrunkCall(
  db: Database,
  args: { payload: Record<string, unknown>; phoneRow: PhoneNumberRow; toNumber: string; now?: Date },
): Promise<TrunkAdmission> {
  const { payload, phoneRow, toNumber } = args;
  const now = args.now ?? new Date();
  const connectionId = String(payload.connection_id ?? '');

  const [trunk] = phoneRow.sipTrunkId
    ? await db.select().from(schema.voipSipTrunks).where(eq(schema.voipSipTrunks.id, phoneRow.sipTrunkId)).limit(1)
    : [];
  if (!trunk) return { ok: false, reason: `The phone system of ${toNumber} no longer exists` };

  if (!trunk.providerConnectionId || trunk.providerConnectionId !== connectionId) {
    // The trunk that owns the connection the call came in on, when this workspace has one.
    const [byConnection] = connectionId
      ? await db
          .select()
          .from(schema.voipSipTrunks)
          .where(eq(schema.voipSipTrunks.providerConnectionId, connectionId))
          .limit(1)
      : [];
    if (byConnection) {
      const reason = `${toNumber} belongs to another phone system than the one the call came from`;
      await recordError(db, byConnection.id, reason, now);
      return { ok: false, reason };
    }
    return { ok: false, reason: `${toNumber} was called over a connection that is not its phone system's` };
  }
  if (trunk.status !== 'active') {
    const reason = `The phone system is switched off, so the call to ${toNumber} was refused`;
    await recordError(db, trunk.id, reason, now);
    return { ok: false, reason };
  }
  return { ok: true, trunk };
}

/** Whether a phone system of this workspace has the connection `connectionId`. */
async function hasTrunkOnConnection(db: Database, connectionId: string): Promise<boolean> {
  const [trunk] = await db
    .select({ id: schema.voipSipTrunks.id })
    .from(schema.voipSipTrunks)
    .where(eq(schema.voipSipTrunks.providerConnectionId, connectionId))
    .limit(1);
  return !!trunk;
}

/**
 * Whether a call that came in over a trunk connection (`isTrunkCall`) may
 * reach `phoneRow`, a number we host (no `sipTrunkId`): the connection is the
 * number's own, or a phone system of this, the destination, workspace has it.
 */
export async function admitTrunkCallToHostedNumber(
  db: Database,
  args: { payload: Record<string, unknown>; phoneRow: PhoneNumberRow },
): Promise<boolean> {
  const connectionId = String(args.payload.connection_id ?? '');
  if (!connectionId) return false;
  if (args.phoneRow.providerConnectionId === connectionId) return true;
  return hasTrunkOnConnection(db, connectionId);
}

/**
 * Whether the workspace of `db` owns the trunk connection an event came in
 * on: one of its phone systems has it, or one of its live numbers is on it (a
 * call `admitTrunkCallToHostedNumber` let in on the number's own connection).
 * The gate for a `client_state` that names this workspace on such an event.
 */
export async function ownsTrunkConnection(db: Database, payload: Record<string, unknown>): Promise<boolean> {
  const connectionId = String(payload.connection_id ?? '');
  if (!connectionId) return false;
  if (await hasTrunkOnConnection(db, connectionId)) return true;
  const n = schema.voipPhoneNumbers;
  const [number] = await db
    .select({ id: n.id })
    .from(n)
    .where(and(eq(n.providerConnectionId, connectionId), isNull(n.deletedAt)))
    .limit(1);
  return !!number;
}

/** A call came in over the trunk: the sign that its setup works. */
export async function recordTrunkInbound(db: Database, trunkId: string, now: Date): Promise<void> {
  await db
    .update(schema.voipSipTrunks)
    .set({ lastInboundAt: now, lastError: null, updatedAt: now })
    .where(eq(schema.voipSipTrunks.id, trunkId));
}
