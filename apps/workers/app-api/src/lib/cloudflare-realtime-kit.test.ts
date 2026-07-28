/**
 * Contract tests for `@weldsuite/cloudflare-realtime`, the RealtimeKit client
 * behind WeldChat calls and WeldMeet meetings.
 *
 * The client moved from hand-written paths to the official `cloudflare` SDK.
 * Two things had to survive that move and are pinned here:
 *
 *  1. The credential. RealtimeKit authenticates with CF_REALTIME_APP_SECRET,
 *     not a general Cloudflare API token. It is handed to the SDK as
 *     `apiToken` purely because the SDK emits it as `Authorization: Bearer` —
 *     the exact header this module sent by hand. If that ever changes, every
 *     call 401s and every meeting breaks.
 *  2. The preset body. RealtimeKit Zod-validates presets server-side and the
 *     shape was arrived at by trial and error against production; a preset
 *     that fails to create means guests cannot join.
 *
 * The package has no test runner of its own, so the tests live here — app-api
 * already depends on it and runs vitest. The stub goes in through the env's
 * `RTK_FETCH` seam, because the SDK captures its own `fetch` reference.
 */

import { describe, it, expect } from 'vitest';
import {
  addParticipant,
  createMeeting,
  endMeeting,
  getRecordings,
  registerWebhook,
  removeParticipant,
  seedPresets,
  RTK_PRESETS,
  type CloudflareRealtimeEnv,
  type RealtimeFetch,
} from '@weldsuite/cloudflare-realtime';

type JsonObject = Record<string, unknown>;
type FetchCall = {
  url: string;
  method: string | undefined;
  auth: string | null;
  body: JsonObject | undefined;
};

/** Narrow a captured request body at the assertion site. */
function body<T extends JsonObject = JsonObject>(call: FetchCall | undefined): T {
  if (!call?.body) throw new Error('expected the call to carry a JSON body');
  return call.body as T;
}

function withResponses(responses: Array<{ status?: number; body: unknown }>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const RTK_FETCH: RealtimeFetch = async (input, init) => {
    const req = init as RequestInit | undefined;
    calls.push({
      url: String(input instanceof Request ? input.url : input),
      method: req?.method,
      auth: new Headers(req?.headers).get('authorization'),
      body: req?.body ? JSON.parse(String(req.body)) : undefined,
    });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const env: CloudflareRealtimeEnv = {
    CF_ACCOUNT_ID: 'acct_1',
    CF_REALTIME_APP_ID: 'app_1',
    CF_REALTIME_APP_SECRET: 'rtk_secret',
    RTK_FETCH,
  };
  return { env, calls };
}

const ok = (data: unknown) => ({ success: true, data });

describe('credential', () => {
  it('authenticates with the RealtimeKit app secret as a bearer token', async () => {
    const { env, calls } = withResponses([{ body: ok({ id: 'm1', created_at: '', updated_at: '' }) }]);

    await createMeeting(env, 'Standup');

    // Not CLOUDFLARE_API_TOKEN — RealtimeKit takes the app secret.
    expect(calls[0]!.auth).toBe('Bearer rtk_secret');
  });

  it('refuses to call without the app secret configured', async () => {
    await expect(createMeeting({ CF_ACCOUNT_ID: 'a', CF_REALTIME_APP_ID: 'b' })).rejects.toThrow(
      'CF_REALTIME_APP_SECRET is not configured',
    );
  });
});

describe('meetings', () => {
  it('creates a meeting on the app-scoped route', async () => {
    const { env, calls } = withResponses([
      { body: ok({ id: 'm1', title: 'Standup', status: 'ACTIVE', created_at: '', updated_at: '' }) },
    ]);

    const meeting = await createMeeting(env, 'Standup');

    expect(calls[0]!.url).toContain('/accounts/acct_1/realtime/kit/app_1/meetings');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ title: 'Standup' });
    expect(meeting).toEqual({ id: 'm1', title: 'Standup', status: 'ACTIVE' });
  });

  it('ends a meeting by patching status to INACTIVE', async () => {
    const { env, calls } = withResponses([{ body: ok({ id: 'm1' }) }]);

    await endMeeting(env, 'm1');

    expect(calls[0]!.url).toContain('/realtime/kit/app_1/meetings/m1');
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.body).toEqual({ status: 'INACTIVE' });
  });

  it('reports a failed call with the status and RealtimeKit detail', async () => {
    const { env } = withResponses([
      { status: 404, body: { success: false, errors: [{ code: 404, message: 'No preset found' }] } },
    ]);

    await expect(createMeeting(env)).rejects.toThrow(/Failed to create RTK meeting: 404.*No preset found/);
  });
});

describe('participants', () => {
  it('sends name, preset and custom id, and returns the join token', async () => {
    const { env, calls } = withResponses([
      {
        body: ok({
          id: 'p1',
          token: 'jwt-token',
          custom_participant_id: 'user_42',
          preset_name: RTK_PRESETS.HOST,
          name: 'Gert',
          created_at: '',
          updated_at: '',
        }),
      },
    ]);

    const participant = await addParticipant(env, 'm1', {
      name: 'Gert',
      customParticipantId: 'user_42',
      presetName: RTK_PRESETS.HOST,
    });

    expect(calls[0]!.url).toContain('/realtime/kit/app_1/meetings/m1/participants');
    expect(calls[0]!.body).toEqual({
      name: 'Gert',
      preset_name: 'group_call_host_v2',
      custom_participant_id: 'user_42',
    });
    expect(participant).toEqual({
      id: 'p1',
      name: 'Gert',
      token: 'jwt-token',
      custom_participant_id: 'user_42',
    });
  });

  it('defaults to the member preset', async () => {
    const { env, calls } = withResponses([
      { body: ok({ id: 'p1', token: 't', custom_participant_id: 'u', preset_name: '', created_at: '', updated_at: '' }) },
    ]);

    await addParticipant(env, 'm1', { name: 'Gert', customParticipantId: 'u' });

    expect(body<{ preset_name: string }>(calls[0]).preset_name).toBe(RTK_PRESETS.MEMBER);
  });

  it('removes a participant on the nested route', async () => {
    const { env, calls } = withResponses([{ body: ok({}) }]);

    await removeParticipant(env, 'm1', 'p1');

    expect(calls[0]!.url).toContain('/realtime/kit/app_1/meetings/m1/participants/p1');
    expect(calls[0]!.method).toBe('DELETE');
  });
});

describe('presets', () => {
  it('creates only the presets that are missing', async () => {
    const { env, calls } = withResponses([
      // List: HOST and MEMBER already exist.
      { body: { success: true, data: [{ name: RTK_PRESETS.HOST }, { name: RTK_PRESETS.MEMBER }], paging: {} } },
      { body: ok({ id: 'preset_guest' }) },
      { body: ok({ id: 'preset_guest_waiting' }) },
    ]);

    await seedPresets(env);

    expect(calls).toHaveLength(3);
    expect(calls[0]!.method).toBe('GET');
    expect(calls.slice(1).map((c) => body<{ name: string }>(c).name)).toEqual([
      RTK_PRESETS.GUEST,
      RTK_PRESETS.GUEST_WAITING,
    ]);
  });

  it('sends the waiting-room and screenshare config the call UI depends on', async () => {
    const { env, calls } = withResponses([
      { body: { success: true, data: [], paging: {} } },
      { body: ok({ id: 'p' }) },
      { body: ok({ id: 'p' }) },
      { body: ok({ id: 'p' }) },
      { body: ok({ id: 'p' }) },
    ]);

    await seedPresets(env);

    type PresetBody = {
      name: string;
      permissions: { waiting_room_type: string; [k: string]: unknown };
      config: { view_type: string; media: { screenshare: JsonObject } };
    };
    const presets = new Map(
      calls.slice(1).map((c) => {
        const preset = body<PresetBody>(c);
        return [preset.name, preset] as const;
      }),
    );
    const preset = (name: string): PresetBody => {
      const found = presets.get(name);
      if (!found) throw new Error(`no preset created for ${name}`);
      return found;
    };

    // Hosts skip the waiting room and can record; guests wait.
    expect(preset(RTK_PRESETS.HOST).permissions).toMatchObject({
      waiting_room_type: 'SKIP',
      accept_waiting_requests: true,
      can_record: true,
    });
    expect(preset(RTK_PRESETS.GUEST).permissions.waiting_room_type).toBe(
      'ON_PRIVILEGED_USER_ENTRY',
    );
    // The explicit-admit preset — a regression here sends share-link guests
    // straight into the call instead of the waiting room.
    expect(preset(RTK_PRESETS.GUEST_WAITING).permissions.waiting_room_type).toBe(
      'SKIP_ON_ACCEPT',
    );

    // WeldMeet overrides RTK's hd/5fps screenshare default.
    expect(preset(RTK_PRESETS.HOST).config.media.screenshare).toEqual({
      quality: 'fhd',
      frame_rate: 30,
    });
    // permissions and ui sit at the ROOT, not under config — RTK rejects the
    // body outright otherwise.
    expect(preset(RTK_PRESETS.HOST)).toHaveProperty('ui.design_tokens.colors.brand.500');
    expect(preset(RTK_PRESETS.HOST).config.view_type).toBe('GROUP_CALL');
  });

  it('does not write the seeded marker when a create fails', async () => {
    const puts: string[] = [];
    const { env } = withResponses([
      { body: { success: true, data: [], paging: {} } },
      { status: 500, body: { success: false, errors: [{ code: 1, message: 'boom' }] } },
    ]);
    env.WORKSPACE_CACHE = {
      get: async () => null,
      put: async (key: string) => {
        puts.push(key);
      },
    };

    await expect(seedPresets(env)).rejects.toThrow(/Failed to create RTK preset/);
    expect(puts).toEqual([]);
  });
});

describe('recordings', () => {
  it('lists recordings for a meeting and exposes the download url', async () => {
    const { env, calls } = withResponses([
      {
        body: {
          success: true,
          paging: {},
          data: [
            {
              id: 'r1',
              status: 'UPLOADED',
              download_url: 'https://example.com/rec.mp4',
              file_size: 1024,
              started_time: '2026-07-26T10:00:00Z',
              stopped_time: '2026-07-26T10:30:00Z',
              audio_download_url: null,
              download_url_expiry: null,
              invoked_time: '',
              output_file_name: '',
              session_id: null,
            },
          ],
        },
      },
    ]);

    const recordings = await getRecordings(env, 'm1');

    expect(calls[0]!.url).toContain('meeting_id=m1');
    expect(recordings[0]).toEqual({
      id: 'r1',
      status: 'UPLOADED',
      download_url: 'https://example.com/rec.mp4',
      file_size: 1024,
      started_time: '2026-07-26T10:00:00Z',
      stopped_time: '2026-07-26T10:30:00Z',
    });
  });
});

describe('webhooks', () => {
  it('registers the meeting-lifecycle receiver', async () => {
    const { env, calls } = withResponses([{ body: ok({ id: 'wh1' }) }]);

    const result = await registerWebhook(env, {
      name: 'WeldSuite meeting lifecycle (production)',
      url: 'https://app-api.weldsuite.org/api/webhooks/cloudflare-realtime?token=t',
      events: ['meeting.ended', 'meeting.participantLeft'],
    });

    expect(calls[0]!.url).toContain('/realtime/kit/app_1/webhooks');
    expect(calls[0]!.method).toBe('POST');
    expect(body<{ events: string[] }>(calls[0]).events).toEqual(['meeting.ended', 'meeting.participantLeft']);
    expect(body<{ enabled: boolean }>(calls[0]).enabled).toBe(true);
    expect(result.id).toBe('wh1');
  });
});
