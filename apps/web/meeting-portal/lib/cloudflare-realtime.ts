/**
 * Cloudflare RealtimeKit Service (meeting-portal)
 *
 * Thin `process.env` adapter over `@weldsuite/cloudflare-realtime`, the single
 * canonical RealtimeKit client (now backed by the official `cloudflare` SDK).
 * The portal reads config from `process.env` instead of Cloudflare Worker
 * `Env` bindings; everything else — routes, payloads, response decoding —
 * lives in the shared package.
 *
 * This file used to hand-roll its own `addParticipant` against a duplicated
 * base URL and header builder, which is exactly the drift the shared package
 * exists to prevent.
 */

import {
  addParticipant as addParticipantShared,
  seedPresets,
  RTK_PRESETS,
  type CloudflareRealtimeEnv,
  type RtkParticipant,
} from '@weldsuite/cloudflare-realtime';

function realtimeEnv(): CloudflareRealtimeEnv {
  return {
    CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
    CF_REALTIME_APP_ID: process.env.CF_REALTIME_APP_ID,
    CF_REALTIME_APP_SECRET: process.env.CF_REALTIME_APP_SECRET,
  };
}

export type { RtkParticipant };

/**
 * Preset names used by WeldMeet. Re-exported from the canonical
 * `@weldsuite/cloudflare-realtime` so the portal and the platform can never
 * disagree on a name (a mismatch here is what produced the 404
 * "No preset found with name group_call_guest_waiting_v2").
 */
export { RTK_PRESETS };

/**
 * Add a participant to a meeting and get their auth token.
 */
export async function addParticipant(
  meetingId: string,
  params: {
    name: string;
    /** Required by RealtimeKit — the id inbound webhooks echo back. */
    customParticipantId: string;
    presetName?: string;
    /** Avatar URL — surfaced on the participant object to every client. */
    picture?: string;
  },
): Promise<RtkParticipant> {
  return addParticipantShared(realtimeEnv(), meetingId, params);
}

// In-memory flag to skip preset checks after first successful run
let presetsSeeded = false;

/**
 * Ensure required presets exist for WeldMeet.
 *
 * Delegates to the single canonical seeder in
 * `@weldsuite/cloudflare-realtime` (the SAME `seedPresets` the platform's
 * app-api host-start path runs) so the portal can never disagree with it on
 * preset bodies. This matters most for `GUEST_WAITING`
 * (waiting_room_type = SKIP_ON_ACCEPT): the portal join route is the ONLY
 * consumer of that preset, so the portal must be able to create it on its own
 * rather than assuming some other worker seeded it first.
 *
 * History: this used to create HOST/MEMBER/GUEST with weak, divergent bodies
 * and deliberately SKIP `GUEST_WAITING`, trusting the platform to have seeded
 * it. When that assumption failed (deploy skew / a stale `rtk-presets-seeded`
 * KV marker on the platform side), `group_call_guest_waiting_v2` was missing
 * and RTK returned 404 on `addParticipant` for every waiting-room guest. The
 * portal now owns its own dependency. `seedPresets` lists existing presets and
 * only creates the missing ones, so this is idempotent, and it throws on any
 * failure — a failed create leaves `presetsSeeded` false so the next request
 * retries instead of caching a half-seed.
 */
export async function ensurePresets(): Promise<void> {
  if (presetsSeeded) return;

  await seedPresets(realtimeEnv());

  presetsSeeded = true;
}
