/**
 * WeldChat — the persistent RealtimeKit room of a DM.
 *
 * A DM (one-to-one or group) keeps one RealtimeKit meeting for all its calls,
 * the way a Discord DM always has its voice channel. Starting a call there
 * then costs no `createMeeting` round-trip to Cloudflare, which was the
 * slowest step between pressing "call" and the other side ringing.
 *
 * The meeting id lives in KV, not on the channel row, so no migration is
 * needed: a miss (first call, expired key) just creates a meeting and stores
 * it again. Each call still gets its own `chat_calls` row and its own
 * `rtk-meeting:<id>` mapping (overwritten per call). Ending a call in the room
 * kicks everyone but leaves the meeting active and the mapping in place, see
 * `teardownRtkMeeting`.
 */

import type { RealtimeKvNamespace } from '@weldsuite/cloudflare-realtime';

/** Refreshed on every call, so only a DM nobody called for this long loses its room. */
export const DM_CALL_ROOM_TTL_SECONDS = 30 * 24 * 60 * 60;

export function dmCallRoomKey(orgId: string, channelId: string): string {
  return `chat-dm-room:${orgId}:${channelId}`;
}

/** The DM's RealtimeKit meeting id, or null when it has none yet (or KV failed). */
export async function getDmCallRoom(
  kv: RealtimeKvNamespace | undefined,
  orgId: string,
  channelId: string,
): Promise<string | null> {
  if (!kv) return null;
  try {
    return (await kv.get(dmCallRoomKey(orgId, channelId))) || null;
  } catch (err) {
    console.error('[DmCallRoom] KV read failed', { orgId, channelId, err });
    return null;
  }
}

/** Remember (or refresh) the DM's meeting. Best effort: a lost write only costs the next call a createMeeting. */
export async function rememberDmCallRoom(
  kv: RealtimeKvNamespace | undefined,
  orgId: string,
  channelId: string,
  meetingId: string,
): Promise<void> {
  if (!kv) return;
  try {
    await kv.put(dmCallRoomKey(orgId, channelId), meetingId, { expirationTtl: DM_CALL_ROOM_TTL_SECONDS });
  } catch (err) {
    console.error('[DmCallRoom] KV write failed', { orgId, channelId, err });
  }
}

/** True when `meetingId` is the DM's persistent room, which must outlive the call. */
export async function isDmCallRoom(
  kv: RealtimeKvNamespace | undefined,
  orgId: string,
  channelId: string,
  meetingId: string,
): Promise<boolean> {
  return (await getDmCallRoom(kv, orgId, channelId)) === meetingId;
}
