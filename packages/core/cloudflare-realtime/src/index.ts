/**
 * Cloudflare RealtimeKit Service (shared)
 *
 * Wraps the Cloudflare RealtimeKit REST API for meeting/participant
 * management. The client SDK (@cloudflare/realtimekit) handles all WebRTC —
 * the backend only creates meetings, adds participants, and returns auth
 * tokens.
 *
 * Pure functions, no Hono / no DB dependency, so both api-worker and
 * core-api can import this package.
 */

const BASE_URL = 'https://api.cloudflare.com/client/v4/accounts';

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
 * declared in callers; missing values throw at call time inside getHeaders
 * / getBaseUrl rather than at the type boundary.
 */
export interface CloudflareRealtimeEnv {
  CF_ACCOUNT_ID?: string;
  CF_REALTIME_APP_ID?: string;
  CF_REALTIME_APP_SECRET?: string;
  WORKSPACE_CACHE?: RealtimeKvNamespace;
}

/** Minimal execution context — only needs `waitUntil`. */
export interface RealtimeExecutionCtx {
  waitUntil(promise: Promise<unknown>): void;
}

function getHeaders(env: CloudflareRealtimeEnv): Record<string, string> {
  if (!env.CF_REALTIME_APP_SECRET) {
    throw new Error('CF_REALTIME_APP_SECRET is not configured');
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env.CF_REALTIME_APP_SECRET}`,
  };
}

function getBaseUrl(env: CloudflareRealtimeEnv): string {
  if (!env.CF_ACCOUNT_ID) throw new Error('CF_ACCOUNT_ID is not configured');
  if (!env.CF_REALTIME_APP_ID) throw new Error('CF_REALTIME_APP_ID is not configured');
  return `${BASE_URL}/${env.CF_ACCOUNT_ID}/realtime/kit/${env.CF_REALTIME_APP_ID}`;
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

export interface RtkRecording {
  id: string;
  status: string;
  download_url?: string;
  file_size?: number;
  started_at?: string;
  stopped_at?: string;
}

// ============================================================================
// Meeting Management
// ============================================================================

export async function createMeeting(
  env: CloudflareRealtimeEnv,
  title?: string,
): Promise<RtkMeeting> {
  const res = await fetch(`${getBaseUrl(env)}/meetings`, {
    method: 'POST',
    headers: getHeaders(env),
    body: JSON.stringify({ title: title ?? 'WeldChat Call' }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create RTK meeting: ${res.status} ${text}`);
  }

  const json: any = await res.json();
  return json.data ?? json.result?.data ?? json.result ?? json;
}

export async function addParticipant(
  env: CloudflareRealtimeEnv,
  meetingId: string,
  params: {
    name: string;
    customParticipantId?: string;
    presetName?: string;
    picture?: string;
  },
): Promise<RtkParticipant> {
  const res = await fetch(`${getBaseUrl(env)}/meetings/${meetingId}/participants`, {
    method: 'POST',
    headers: getHeaders(env),
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

export async function endMeeting(
  env: CloudflareRealtimeEnv,
  meetingId: string,
): Promise<void> {
  const res = await fetch(`${getBaseUrl(env)}/meetings/${meetingId}`, {
    method: 'PATCH',
    headers: getHeaders(env),
    body: JSON.stringify({ status: 'INACTIVE' }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to end RTK meeting: ${res.status} ${text}`);
  }
}

export async function removeParticipant(
  env: CloudflareRealtimeEnv,
  meetingId: string,
  participantId: string,
): Promise<void> {
  const res = await fetch(
    `${getBaseUrl(env)}/meetings/${meetingId}/participants/${participantId}`,
    { method: 'DELETE', headers: getHeaders(env) },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to remove RTK participant: ${res.status} ${text}`);
  }
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
 * Force-seed presets and update the KV cache. Safe to call from a startup
 * task / admin endpoint. Always performs the network calls.
 */
export async function seedPresets(env: CloudflareRealtimeEnv): Promise<void> {
  const baseUrl = getBaseUrl(env).replace(/\/meetings.*$/, '');
  const headers = getHeaders(env);

  const listRes = await fetch(`${baseUrl}/presets`, { headers });
  if (!listRes.ok) {
    throw new Error(`Failed to list RTK presets: ${listRes.status} ${await listRes.text()}`);
  }
  const existing = new Set<string>();
  const listJson: any = await listRes.json();
  const presets: any[] = listJson.data ?? listJson.result?.data ?? [];
  for (const p of presets) {
    if (p.name) existing.add(p.name);
  }

  // POSTs must throw on non-2xx — otherwise we'd cache "seeded=1" while
  // presets are missing, and every subsequent participant create would 404.
  async function createPreset(body: unknown): Promise<void> {
    const res = await fetch(`${baseUrl}/presets`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Failed to create RTK preset: ${res.status} ${await res.text()}`);
    }
  }

  // RTK's preset schema is strict (Zod-validated on the server). It rejects
  // unknown keys and requires the full canonical shape: `permissions` and
  // `ui` at the ROOT (not nested under config), `config.view_type` enum,
  // `config.media.video`, `config.max_video_streams`, and
  // `config.max_screenshare_count`. The shape below mirrors RealtimeKit's
  // internal default preset (see @cloudflare/realtimekit dist/index.es.js)
  // with three WeldMeet-specific overrides:
  //   - transcription_enabled — host UI shows live captions
  //   - screenshare.quality   — fhd (1080p) instead of RTK's hd (720p)
  //   - screenshare.frame_rate — 30 instead of RTK's 5
  //
  // RTK's preset default screenshare is `{ quality: "hd", frame_rate: 5 }`
  // and the producer encoder enforces this cap server-side regardless of
  // any client-side getDisplayMedia constraints. Per WeldMeet UX policy
  // (quality > smoothness > delay) we override to fhd/30.
  function buildPresetBody(opts: {
    name: string;
    acceptWaitingRequests: boolean;
    waitingRoomType: 'SKIP' | 'ON_PRIVILEGED_USER_ENTRY' | 'SKIP_ON_ACCEPT' | 'NONE';
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
          video: { can_produce: 'ALLOWED' },
          audio: { can_produce: 'ALLOWED' },
          screenshare: { can_produce: 'ALLOWED' },
        },
        chat: {
          public: { can_send: true, text: true, files: true },
          private: { can_send: true, can_receive: true, text: true, files: true },
        },
        hidden_participant: false,
        is_recorder: false,
        recorder_type: 'NONE',
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
        // WeldMeet's React UI doesn't render anything from them (we use our
        // own shadcn-based call UI). These values mirror the SDK's built-in
        // defaults; RTK rejects partial objects, so all five keys must be
        // present. If RTK rejects the simple-hex `colors` shape we'll need
        // to switch to its tier object format.
        design_tokens: {
          border_radius: 'rounded',
          border_width: 'thin',
          spacing_base: 4,
          theme: 'dark',
          colors: {
            // `brand` and `background` are tier objects (RTK's strict schema
            // requires five shade keys). Other colors are plain hex strings.
            // brand tiers: 300/400/500/600/700; background tiers: 1000/900/800/700/600.
            // Values mirror the SDK's dark-theme defaults; WeldMeet renders
            // its own call UI on top, so these never reach pixels.
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
        view_type: 'GROUP_CALL',
        media: {
          audio: { enable_stereo: false, enable_high_bitrate: false },
          // Webcam video left at RTK defaults — this change is scoped to
          // screen share quality. Bump these later if needed.
          video: { quality: 'vga', frame_rate: 30, simulcast: false },
          screenshare: { quality: 'fhd', frame_rate: 30 },
        },
        max_video_streams: { mobile: 6, desktop: 6 },
        max_screenshare_count: 1,
        track_recording: { subscriptions: [] },
      },
    };
  }

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
  //                     ctx.waitUntil, and (b) createPreset() throws on
  //                     non-2xx so a partial seed will not poison the cache.
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
  // (createPreset() throws on non-2xx, so a partial seed never reaches this
  // line — the marker can't be written while presets are missing.)
  await env.WORKSPACE_CACHE?.put('rtk-presets-seeded-v6', '1');
}

// ============================================================================
// Recording Management
// ============================================================================

export async function getRecording(
  env: CloudflareRealtimeEnv,
  recordingId: string,
): Promise<RtkRecording> {
  const baseUrl = getBaseUrl(env).replace(/\/meetings.*$/, '');
  const res = await fetch(`${baseUrl}/recordings/${recordingId}`, {
    headers: getHeaders(env),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get recording: ${res.status} ${text}`);
  }

  const json: any = await res.json();
  return json.data ?? json.result?.data ?? json.result ?? json;
}

export async function getRecordings(
  env: CloudflareRealtimeEnv,
  meetingId: string,
): Promise<RtkRecording[]> {
  const baseUrl = getBaseUrl(env).replace(/\/meetings.*$/, '');
  const res = await fetch(`${baseUrl}/recordings?meeting_id=${meetingId}`, {
    headers: getHeaders(env),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to list recordings: ${res.status} ${text}`);
  }

  const json: any = await res.json();
  return json.data ?? json.result?.data ?? [];
}
