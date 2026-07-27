/**
 * Cloudflare RealtimeKit Service (shared)
 *
 * Wraps the Cloudflare RealtimeKit REST API for meeting/participant
 * management. The client SDK (@cloudflare/realtimekit) handles all WebRTC —
 * the backend only creates meetings, adds participants, and returns auth
 * tokens.
 *
 * Backed by the official `cloudflare` SDK via `cloudflare/tree-shakable`, so
 * routes and payloads come from Cloudflare's generated types instead of
 * hand-written strings. That matters most for {@link seedPresets}: RealtimeKit
 * validates the preset body against a strict server-side schema, and the shape
 * below was arrived at by trial and error against production. It is now
 * type-checked at build time.
 *
 * Pure functions, no Hono / no DB dependency, so every caller can import this.
 *
 * SDK: https://github.com/cloudflare/cloudflare-typescript
 */

import { createClient } from 'cloudflare/tree-shakable';
import { APIError } from 'cloudflare/core/error';
import { BaseMeetings } from 'cloudflare/resources/realtime-kit/meetings';
import { BasePresets } from 'cloudflare/resources/realtime-kit/presets';
import { BaseRecordings } from 'cloudflare/resources/realtime-kit/recordings';
import { BaseWebhooks } from 'cloudflare/resources/realtime-kit/webhooks';
import type { WebhookCreateWebhookParams } from 'cloudflare/resources/realtime-kit/webhooks';
import type { ClientOptions } from 'cloudflare/client';

// ============================================================================
// Env contract
// ============================================================================

/** Minimal KV-like interface — avoids depending on @cloudflare/workers-types. */
export interface RealtimeKvNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

/**
 * Minimal env contract callers must satisfy. All three string vars are
 * optional in the type to match how Cloudflare Workers `Env` shapes are
 * declared in callers; missing values throw at call time inside
 * {@link realtime} rather than at the type boundary.
 */
export interface CloudflareRealtimeEnv {
  CF_ACCOUNT_ID?: string;
  CF_REALTIME_APP_ID?: string;
  CF_REALTIME_APP_SECRET?: string;
  WORKSPACE_CACHE?: RealtimeKvNamespace;
  /**
   * Override the SDK's `fetch`. Tests inject a stub here — the SDK holds its
   * own reference, so patching `globalThis.fetch` does not intercept it and a
   * test that tries would hit api.cloudflare.com for real. Never set in
   * production; Worker `Env` shapes simply omit it.
   */
  RTK_FETCH?: RealtimeFetch;
}

/** The SDK's `fetch` signature, exported so tests can type their stub. */
export type RealtimeFetch = NonNullable<ClientOptions['fetch']>;

/** Minimal execution context — only needs `waitUntil`. */
export interface RealtimeExecutionCtx {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Resolve the three values every call needs, plus an SDK client.
 *
 * The credential is `CF_REALTIME_APP_SECRET`, not a general Cloudflare API
 * token. It is passed as the SDK's `apiToken` because the SDK sends it as
 * `Authorization: Bearer <value>` — byte-identical to the header this module
 * sent by hand before. Do not "fix" this to CLOUDFLARE_API_TOKEN.
 */
function realtime(env: CloudflareRealtimeEnv) {
  if (!env.CF_ACCOUNT_ID) throw new Error('CF_ACCOUNT_ID is not configured');
  if (!env.CF_REALTIME_APP_ID) throw new Error('CF_REALTIME_APP_ID is not configured');
  if (!env.CF_REALTIME_APP_SECRET) throw new Error('CF_REALTIME_APP_SECRET is not configured');

  return {
    accountId: env.CF_ACCOUNT_ID,
    appId: env.CF_REALTIME_APP_ID,
    client: createClient({
      apiToken: env.CF_REALTIME_APP_SECRET,
      maxRetries: 2,
      timeout: 15_000,
      ...(env.RTK_FETCH ? { fetch: env.RTK_FETCH } : {}),
      resources: [BaseMeetings, BasePresets, BaseRecordings, BaseWebhooks],
    }),
  };
}

/**
 * Preserve the "Failed to X: <status> <body>" error text callers and dashboards
 * already grep for, while keeping the HTTP status and RealtimeKit's own error
 * payload in the message.
 */
async function call<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof APIError)) throw err;
    const detail =
      (err.errors ?? []).map((e) => `${e.code}:${e.message}`).join('; ') || err.message || '';
    throw new Error(`Failed to ${what}: ${err.status ?? '(no status)'} ${detail}`);
  }
}

// ============================================================================
// Types
// ============================================================================

export interface RtkMeeting {
  id: string;
  title?: string;
  status?: string;
}

export interface RtkParticipant {
  id: string;
  name: string;
  token: string;
  custom_participant_id?: string;
}

/**
 * Recording timestamps are `started_time` / `stopped_time` on the wire. This
 * type used to declare `started_at` / `stopped_at`, which were therefore always
 * undefined; only `download_url` is actually read by callers.
 */
export interface RtkRecording {
  id: string;
  status: string;
  download_url?: string;
  file_size?: number;
  started_time?: string;
  stopped_time?: string;
}

// ============================================================================
// Meeting Management
// ============================================================================

export async function createMeeting(
  env: CloudflareRealtimeEnv,
  title?: string,
): Promise<RtkMeeting> {
  const { client, accountId, appId } = realtime(env);
  const res = await call('create RTK meeting', () =>
    client.realtimeKit.meetings.create(appId, {
      account_id: accountId,
      title: title ?? 'WeldChat Call',
    }),
  );
  const data = res.data;
  if (!data) throw new Error('Failed to create RTK meeting: response carried no meeting');
  return { id: data.id, title: data.title ?? undefined, status: data.status };
}

export async function addParticipant(
  env: CloudflareRealtimeEnv,
  meetingId: string,
  params: {
    name: string;
    /**
     * Required by RealtimeKit — it is the id inbound webhooks echo back. Was
     * optional here, but every call site passes one and a request without it
     * is rejected.
     */
    customParticipantId: string;
    presetName?: string;
    picture?: string;
  },
): Promise<RtkParticipant> {
  const { client, accountId, appId } = realtime(env);
  const res = await call('add RTK participant', () =>
    client.realtimeKit.meetings.addParticipant(meetingId, {
      account_id: accountId,
      app_id: appId,
      name: params.name,
      preset_name: params.presetName ?? RTK_PRESETS.MEMBER,
      custom_participant_id: params.customParticipantId,
      ...(params.picture ? { picture: params.picture } : {}),
    }),
  );
  const data = res.data;
  if (!data) throw new Error('Failed to add RTK participant: response carried no participant');
  return {
    id: data.id,
    name: data.name ?? params.name,
    token: data.token,
    custom_participant_id: data.custom_participant_id,
  };
}

export async function endMeeting(
  env: CloudflareRealtimeEnv,
  meetingId: string,
): Promise<void> {
  const { client, accountId, appId } = realtime(env);
  await call('end RTK meeting', () =>
    client.realtimeKit.meetings.updateMeetingByID(meetingId, {
      account_id: accountId,
      app_id: appId,
      status: 'INACTIVE',
    }),
  );
}

export async function removeParticipant(
  env: CloudflareRealtimeEnv,
  meetingId: string,
  participantId: string,
): Promise<void> {
  const { client, accountId, appId } = realtime(env);
  await call('remove RTK participant', () =>
    client.realtimeKit.meetings.deleteMeetingParticipant(participantId, {
      account_id: accountId,
      app_id: appId,
      meeting_id: meetingId,
    }),
  );
}

// ============================================================================
// Preset Management
// ============================================================================

/**
 * Preset names used by WeldMeet.
 *
 * Names carry a version suffix because RTK refuses to delete a preset that's
 * "in use by participants" (any participant token issued against it counts,
 * even ones whose meeting has long since ended). Each time the preset config
 * changes — quality cap, permissions, etc. — we bump the suffix and let the
 * old preset linger as an orphan. seedPresets() creates the new versions on
 * the next deploy; old participants on old tokens keep working until their
 * tokens expire.
 *
 * Version log:
 *   v1 (unversioned) — initial presets
 *   v2              — added media.screenshare = fhd/30fps (was hd/5fps default)
 *
 * Two guest presets exist by design:
 *   GUEST          — waiting_room_type = ON_PRIVILEGED_USER_ENTRY. Guests wait
 *                    only until a host is present, then auto-admit. Used when
 *                    the meeting's `waitingRoom` flag is OFF.
 *   GUEST_WAITING  — waiting_room_type = SKIP_ON_ACCEPT. Guests always wait for
 *                    an explicit host admit/deny (surfaced in the platform's
 *                    AdmitGuestsPill). Used when `waitingRoom` is ON.
 */
export const RTK_PRESETS = {
  HOST: 'group_call_host_v2',
  MEMBER: 'group_call_participant_v2',
  GUEST: 'group_call_guest_v2',
  // v2: forces a fresh re-seed. A `group_call_guest_waiting_v1` preset existed
  // in RTK without the SKIP_ON_ACCEPT waiting-room behaviour (created early by
  // a weak/legacy seed body); RTK refuses to overwrite an in-use preset, so a
  // guest joining via the share link skipped straight in instead of waiting.
  // Renaming forces seedPresets to create a correctly-configured preset.
  GUEST_WAITING: 'group_call_guest_waiting_v2',
} as const;

/**
 * Ensure required presets exist for WeldMeet.
 *
 * Behaviour:
 * - On KV hit: returns immediately (the steady-state path — a single KV get).
 * - On KV miss: AWAITS seedPresets before returning, then writes the cache key.
 *
 * Earlier versions of this function used `ctx.waitUntil(seedPresets)` to avoid
 * blocking the first request after a deploy on ~4 calls to api.cloudflare.com.
 * That created a race: if a request following a preset-name bump arrived
 * before the background seed finished, `addParticipant` would 404 because the
 * preset it referenced did not yet exist. Correctness wins — we pay the seed
 * cost once per deploy (or once per 24h cache expiry) and every subsequent
 * request is fast again.
 *
 * The `ctx` parameter is kept for API compatibility with existing callers but
 * is no longer used.
 */
export async function ensurePresets(
  env: CloudflareRealtimeEnv,
  _ctx?: RealtimeExecutionCtx,
): Promise<void> {
  const cacheKey = 'rtk-presets-seeded-v6';
  const cached = await env.WORKSPACE_CACHE?.get(cacheKey);
  if (cached) return;

  await seedPresets(env);
}

/**
 * RTK's preset schema is strict (Zod-validated on the server). It rejects
 * unknown keys and requires the full canonical shape: `permissions` and `ui`
 * at the ROOT (not nested under config), `config.view_type` enum,
 * `config.media.video`, `config.max_video_streams`, and
 * `config.max_screenshare_count`. The shape below mirrors RealtimeKit's
 * internal default preset (see @cloudflare/realtimekit dist/index.es.js) with
 * three WeldMeet-specific overrides:
 *   - transcription_enabled — host UI shows live captions
 *   - screenshare.quality   — fhd (1080p) instead of RTK's hd (720p)
 *   - screenshare.frame_rate — 30 instead of RTK's 5
 *
 * RTK's preset default screenshare is `{ quality: "hd", frame_rate: 5 }` and
 * the producer encoder enforces this cap server-side regardless of any
 * client-side getDisplayMedia constraints. Per WeldMeet UX policy
 * (quality > smoothness > delay) we override to fhd/30.
 */
function buildPresetBody(opts: {
  name: string;
  acceptWaitingRequests: boolean;
  /**
   * RealtimeKit accepts exactly these three. A fourth, `'NONE'`, used to be
   * listed here — it is not valid and RTK's schema would have rejected it at
   * runtime had anything passed it.
   */
  waitingRoomType: 'SKIP' | 'ON_PRIVILEGED_USER_ENTRY' | 'SKIP_ON_ACCEPT';
  canRecord: boolean;
}) {
  return {
    name: opts.name,
    permissions: {
      can_accept_production_requests: false,
      can_edit_display_name: true,
      accept_waiting_requests: opts.acceptWaitingRequests,
      disable_participant_audio: false,
      disable_participant_screensharing: false,
      disable_participant_video: false,
      can_spotlight: opts.acceptWaitingRequests, // hosts can spotlight
      kick_participant: opts.acceptWaitingRequests,
      pin_participant: opts.acceptWaitingRequests,
      can_record: opts.canRecord,
      can_livestream: false,
      waiting_room_type: opts.waitingRoomType,
      plugins: { can_close: true, can_start: true, can_edit_config: false, config: {} },
      polls: { can_create: true, can_vote: true, can_view: true },
      media: {
        video: { can_produce: 'ALLOWED' as const },
        audio: { can_produce: 'ALLOWED' as const },
        screenshare: { can_produce: 'ALLOWED' as const },
      },
      chat: {
        public: { can_send: true, text: true, files: true },
        private: { can_send: true, can_receive: true, text: true, files: true },
      },
      hidden_participant: false,
      is_recorder: false,
      recorder_type: 'NONE' as const,
      show_participant_list: true,
      transcription_enabled: true,
      can_change_participant_permissions: opts.acceptWaitingRequests,
      connected_meetings: {
        can_alter_connected_meetings: false,
        can_switch_connected_meetings: false,
        can_switch_to_parent_meeting: false,
      },
      stage_enabled: false,
      accept_stage_requests: false,
    },
    ui: {
      // design_tokens are required by RTK's preset schema even though
      // WeldMeet's React UI doesn't render anything from them (we use our own
      // shadcn-based call UI). These values mirror the SDK's built-in
      // defaults; RTK rejects partial objects, so all five keys must be
      // present.
      design_tokens: {
        border_radius: 'rounded' as const,
        border_width: 'thin' as const,
        spacing_base: 4,
        theme: 'dark' as const,
        colors: {
          // `brand` and `background` are tier objects (RTK's strict schema
          // requires five shade keys). Other colors are plain hex strings.
          // brand tiers: 300/400/500/600/700; background tiers:
          // 1000/900/800/700/600. Values mirror the SDK's dark-theme defaults;
          // WeldMeet renders its own call UI on top, so these never reach
          // pixels.
          brand: {
            300: '#9FBAFF',
            400: '#5C8AFF',
            500: '#2160FD',
            600: '#1E50D6',
            700: '#1840AA',
          },
          background: {
            1000: '#252525',
            900: '#2F2F2F',
            800: '#323232',
            700: '#3E3E3E',
            600: '#4A4A4A',
          },
          danger: '#FF2D2D',
          text: '#EEEEEE',
          text_on_brand: '#EEEEEE',
          success: '#62A504',
          video_bg: '#191919',
          warning: '#FFCD07',
        },
      },
      config_diff: {},
    },
    config: {
      view_type: 'GROUP_CALL' as const,
      media: {
        audio: { enable_stereo: false, enable_high_bitrate: false },
        // Webcam video left at RTK defaults — this change is scoped to screen
        // share quality. Bump these later if needed.
        video: { quality: 'vga' as const, frame_rate: 30, simulcast: false },
        screenshare: { quality: 'fhd' as const, frame_rate: 30 },
      },
      max_video_streams: { mobile: 6, desktop: 6 },
      max_screenshare_count: 1,
      track_recording: { subscriptions: [] },
    },
  };
}

/**
 * Force-seed presets and update the KV cache. Safe to call from a startup
 * task / admin endpoint. Always performs the network calls.
 */
export async function seedPresets(env: CloudflareRealtimeEnv): Promise<void> {
  const { client, accountId, appId } = realtime(env);

  const listed = await call('list RTK presets', () =>
    client.realtimeKit.presets.get(appId, { account_id: accountId }),
  );
  const existing = new Set<string>();
  for (const p of listed.data ?? []) {
    if (p.name) existing.add(p.name);
  }

  // Creates must throw on failure — otherwise we'd cache "seeded=1" while
  // presets are missing, and every subsequent participant create would 404.
  const createPreset = (body: ReturnType<typeof buildPresetBody>) =>
    call('create RTK preset', () =>
      client.realtimeKit.presets.create(appId, { account_id: accountId, ...body }),
    );

  if (!existing.has(RTK_PRESETS.HOST)) {
    await createPreset(buildPresetBody({
      name: RTK_PRESETS.HOST,
      acceptWaitingRequests: true,
      waitingRoomType: 'SKIP',
      canRecord: true,
    }));
  }

  if (!existing.has(RTK_PRESETS.MEMBER)) {
    await createPreset(buildPresetBody({
      name: RTK_PRESETS.MEMBER,
      acceptWaitingRequests: false,
      waitingRoomType: 'SKIP',
      canRecord: false,
    }));
  }

  if (!existing.has(RTK_PRESETS.GUEST)) {
    await createPreset(buildPresetBody({
      name: RTK_PRESETS.GUEST,
      acceptWaitingRequests: false,
      waitingRoomType: 'ON_PRIVILEGED_USER_ENTRY',
      canRecord: false,
    }));
  }

  // Explicit-admit guest preset for meetings with `waitingRoom` enabled. The
  // host must accept each request via AdmitGuestsPill (acceptWaitingRoomRequest).
  if (!existing.has(RTK_PRESETS.GUEST_WAITING)) {
    await createPreset(buildPresetBody({
      name: RTK_PRESETS.GUEST_WAITING,
      acceptWaitingRequests: false,
      waitingRoomType: 'SKIP_ON_ACCEPT',
      canRecord: false,
    }));
  }

  // Cache key version log:
  //   v1 (unversioned) — initial seed
  //   v2              — added transcriptionEnabled permission
  //   v3              — added media.screenshare = fhd/30fps
  //   v4              — invalidates any v3 cache poisoned by an earlier
  //                     fire-and-forget seed that completed AFTER the cache
  //                     was written. Combined with: (a) ensurePresets now
  //                     awaits seedPresets on miss instead of using
  //                     ctx.waitUntil, and (b) preset creates throw on
  //                     failure so a partial seed will not poison the cache.
  //   v5              — added GUEST_WAITING (SKIP_ON_ACCEPT) preset for the
  //                     explicit-admit waiting room.
  //   v6              — renamed GUEST_WAITING v1 → v2 to force a re-seed: the
  //                     v1 preset was stuck in RTK without SKIP_ON_ACCEPT, so
  //                     share-link guests skipped the waiting room.
  //
  // RTK refuses to recreate a preset whose name is still in use by any
  // participant token — that's why each config bump renames the preset
  // (RTK_PRESETS suffix bump) instead of trying to delete-and-recreate.
  //
  // The marker is written WITHOUT a TTL so it persists indefinitely. Presets
  // are immutable between version-suffix bumps (a config change always bumps
  // the suffix → a new cache key → a re-seed), so a recurring expiry bought us
  // nothing but a periodic latency cliff: whichever unlucky request first hit
  // the expired key paid ~5 serial api.cloudflare.com roundtrips (1 list + up
  // to 4 creates) on its critical path — e.g. the "instant meeting sometimes
  // takes a long time" symptom. With no TTL the seed runs exactly once per
  // preset version, ever; every later request is a single warm KV get.
  // (Preset creates throw on failure, so a partial seed never reaches this
  // line — the marker can't be written while presets are missing.)
  await env.WORKSPACE_CACHE?.put('rtk-presets-seeded-v6', '1');
}

// ============================================================================
// Webhook Registration
// ============================================================================

/** Events RealtimeKit can push. Narrowed from the SDK so a typo fails to compile. */
export type RtkWebhookEvent = WebhookCreateWebhookParams['events'][number];

/**
 * Register a webhook receiver with RealtimeKit. Called from the app-api
 * `/api/webhooks/cloudflare-realtime/setup` admin route after a deploy that
 * changes the receiver URL or the event set.
 */
export async function registerWebhook(
  env: CloudflareRealtimeEnv,
  params: { name: string; url: string; events: RtkWebhookEvent[]; enabled?: boolean },
): Promise<{ id?: string }> {
  const { client, accountId, appId } = realtime(env);
  const res = await call('register RTK webhook', () =>
    client.realtimeKit.webhooks.createWebhook(appId, {
      account_id: accountId,
      name: params.name,
      url: params.url,
      events: params.events,
      enabled: params.enabled ?? true,
    }),
  );
  return { id: res.data?.id };
}

// ============================================================================
// Recording Management
// ============================================================================

function toRecording(r: {
  id: string;
  status: string;
  download_url?: string | null;
  file_size?: number | null;
  started_time?: string | null;
  stopped_time?: string | null;
}): RtkRecording {
  return {
    id: r.id,
    status: r.status,
    download_url: r.download_url ?? undefined,
    file_size: r.file_size ?? undefined,
    started_time: r.started_time ?? undefined,
    stopped_time: r.stopped_time ?? undefined,
  };
}

export async function getRecording(
  env: CloudflareRealtimeEnv,
  recordingId: string,
): Promise<RtkRecording> {
  const { client, accountId, appId } = realtime(env);
  const res = await call('get recording', () =>
    client.realtimeKit.recordings.getOneRecording(recordingId, {
      account_id: accountId,
      app_id: appId,
    }),
  );
  const data = res.data;
  if (!data) throw new Error(`Failed to get recording: ${recordingId} not found`);
  return toRecording(data);
}

export async function getRecordings(
  env: CloudflareRealtimeEnv,
  meetingId: string,
): Promise<RtkRecording[]> {
  const { client, accountId, appId } = realtime(env);
  const res = await call('list recordings', () =>
    client.realtimeKit.recordings.getRecordings(appId, {
      account_id: accountId,
      meeting_id: meetingId,
    }),
  );
  return (res.data ?? []).map(toRecording);
}
