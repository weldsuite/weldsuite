/**
 * A RealtimeKit participant minted while a call rings (POST /:callId/prepare)
 * and handed out again by the join that answers it.
 *
 * Adding a participant is a round-trip to the Cloudflare API, and it used to
 * sit between the callee clicking "accept" and their client starting to
 * connect. The callee's client now asks for the token as soon as the ring
 * arrives, and connects with it on accept while POST /join only records the
 * answer. The join reuses the participant parked here, so the room never sees
 * a second one for the same click.
 *
 * KV is enough: both requests come from the same client a few seconds apart.
 * A miss (expired, or not yet visible) only means the join adds a participant
 * of its own, as before; the RTK webhooks match the user by
 * `customParticipantId`, so the connection the client opened with the prepared
 * token is still recognised.
 */

/** KV's minimum TTL; a ring lasts 25s, so a prepared token never outlives it by much. */
export const PREPARED_JOIN_TTL_SECONDS = 60;

export interface PreparedJoin {
  /** The RTK meeting the participant was added to; a join into another room ignores it. */
  meetingId: string;
  participantId: string;
  token: string;
}

interface PreparedJoinKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export function preparedJoinKey(callId: string, userId: string): string {
  return `chat-call-prepared:${callId}:${userId}`;
}

export async function storePreparedJoin(
  kv: PreparedJoinKv,
  callId: string,
  userId: string,
  prepared: PreparedJoin,
): Promise<void> {
  await kv.put(preparedJoinKey(callId, userId), JSON.stringify(prepared), {
    expirationTtl: PREPARED_JOIN_TTL_SECONDS,
  });
}

/** The parked participant, or null. Never throws: a miss falls back to adding one. */
export async function readPreparedJoin(
  kv: PreparedJoinKv,
  callId: string,
  userId: string,
): Promise<PreparedJoin | null> {
  try {
    const raw = await kv.get(preparedJoinKey(callId, userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PreparedJoin>;
    return parsed.meetingId && parsed.participantId && parsed.token
      ? { meetingId: parsed.meetingId, participantId: parsed.participantId, token: parsed.token }
      : null;
  } catch {
    return null;
  }
}

/** Used once: a later join (another tab, a rejoin) gets a fresh participant. */
export async function consumePreparedJoin(kv: PreparedJoinKv, callId: string, userId: string): Promise<void> {
  try {
    await kv.delete(preparedJoinKey(callId, userId));
  } catch {
    /* expires on its own */
  }
}
