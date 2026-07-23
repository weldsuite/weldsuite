/**
 * Cloudflare RealtimeKit Service
 *
 * Wraps the Cloudflare RealtimeKit REST API for guest participant management.
 * Adapted from apps/api-worker/src/services/cloudflare-realtime/index.ts
 * to read from process.env instead of Cloudflare Worker Env bindings.
 */

import {
  seedPresets,
  RTK_PRESETS,
  type CloudflareRealtimeEnv,
} from '@weldsuite/cloudflare-realtime';

const BASE_URL = 'https://api.cloudflare.com/client/v4/accounts';

function getHeaders(): Record<string, string> {
  const secret = process.env.CF_REALTIME_APP_SECRET;
  if (!secret) throw new Error('CF_REALTIME_APP_SECRET is not configured');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${secret}`,
  };
}

function getBaseUrl(): string {
  const accountId = process.env.CF_ACCOUNT_ID;
  const appId = process.env.CF_REALTIME_APP_ID;
  if (!accountId) throw new Error('CF_ACCOUNT_ID is not configured');
  if (!appId) throw new Error('CF_REALTIME_APP_ID is not configured');
  return `${BASE_URL}/${accountId}/realtime/kit/${appId}`;
}

export interface RtkParticipant {
  id: string;
  name: string;
  token: string;
  custom_participant_id?: string;
}

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
    customParticipantId?: string;
    presetName?: string;
    /** Avatar URL — surfaced on the participant object to every client. */
    picture?: string;
  },
): Promise<RtkParticipant> {
  const res = await fetch(`${getBaseUrl()}/meetings/${meetingId}/participants`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      name: params.name,
      preset_name: params.presetName ?? RTK_PRESETS.MEMBER,
      custom_participant_id: params.customParticipantId,
      picture: params.picture,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to add RTK participant: ${res.status} ${text}`);
  }

  const json: any = await res.json();
  return json.data ?? json.result?.data ?? json.result ?? json;
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
 * non-2xx — a failed create leaves `presetsSeeded` false so the next request
 * retries instead of caching a half-seed.
 */
export async function ensurePresets(): Promise<void> {
  if (presetsSeeded) return;

  const env: CloudflareRealtimeEnv = {
    CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
    CF_REALTIME_APP_ID: process.env.CF_REALTIME_APP_ID,
    CF_REALTIME_APP_SECRET: process.env.CF_REALTIME_APP_SECRET,
  };

  await seedPresets(env);

  presetsSeeded = true;
}
