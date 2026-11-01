/**
 * In-memory stand-ins for the Cloudflare bindings meet-api's tests need: KV,
 * the private R2 bucket, a Workflow binding, the REALTIME service and
 * RealtimeKit's REST API. Test-only.
 */

import { vi } from 'vitest';
import { schema, type Database } from '@weldsuite/worker-kit/db';

// ============================================================================
// RealtimeKit's REST API, at the HTTP level
// ============================================================================

const RTK_ACCOUNT = 'acc_test';
const RTK_APP = 'app_test';
/** Where `@weldsuite/cloudflare-realtime` (the official SDK) sends every call. */
export const RTK_BASE = `https://api.cloudflare.com/client/v4/accounts/${RTK_ACCOUNT}/realtime/kit/${RTK_APP}`;

/**
 * The env that points `@weldsuite/cloudflare-realtime` at the fake API:
 * RealtimeKit's credentials and an `RTK_FETCH` that goes through
 * `globalThis.fetch` at call time, so the conformance harness records the
 * calls and the Rust server reaches the same stub through its outbound bridge.
 */
export const RTK_ENV = {
  CF_ACCOUNT_ID: RTK_ACCOUNT,
  CF_REALTIME_APP_ID: RTK_APP,
  CF_REALTIME_APP_SECRET: 'rtk_secret_test',
  RTK_FETCH: ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch,
};

/** The KV marker that tells `ensurePresets` the presets are seeded. */
export const RTK_PRESETS_SEEDED = { 'rtk-presets-seeded-v7': '1' };

/** What a fake RealtimeKit call did. */
export type RtkCallKind =
  | 'create'
  | 'update'
  | 'end'
  | 'add'
  | 'remove'
  | 'live'
  | 'kick'
  | 'kick-all'
  | 'recordings'
  | 'presets'
  | 'create-preset'
  | 'webhooks'
  | 'create-webhook'
  | 'replace-webhook'
  | 'delete-webhook';

export interface RtkCall {
  kind: RtkCallKind;
  method: string;
  /** The RealtimeKit meeting the call is about, when it names one. */
  room: string | null;
  /** The path below the app (`/meetings/m1/active-session`), query included. */
  path: string;
  body: unknown;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Classified = { kind: RtkCallKind; room: string | null };

/** `/meetings/...`: by the segments after `meetings`, and the method. */
function classifyMeetingCall(method: string, parts: string[]): Classified | null {
  const room = parts[1] ?? null;
  // What follows the room: `participants[/<id>]`, `active-session[/kick|/kick-all]`.
  const sub = parts[2] === 'active-session' ? parts.slice(2).join('/') : (parts[2] ?? '');
  const kinds: Record<string, RtkCallKind> = {
    'POST ': 'create',
    'PATCH ': 'update',
    'POST participants': 'add',
    'DELETE participants': 'remove',
    'GET active-session': 'live',
    'POST active-session/kick': 'kick',
    'POST active-session/kick-all': 'kick-all',
  };
  const kind = kinds[`${method} ${sub}`];
  if (!kind) return null;
  return { kind, room: kind === 'create' ? null : room };
}

const WEBHOOK_KINDS: Record<string, RtkCallKind> = {
  GET: 'webhooks',
  POST: 'create-webhook',
  PUT: 'replace-webhook',
  DELETE: 'delete-webhook',
};

function classify(method: string, path: string): Classified | null {
  const [pathname, query] = path.split('?');
  const parts = pathname!.split('/').filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case 'meetings':
      return classifyMeetingCall(method, parts);
    case 'recordings':
      return method === 'GET' ? { kind: 'recordings', room: new URLSearchParams(query ?? '').get('meeting_id') } : null;
    case 'presets':
      return { kind: method === 'POST' ? 'create-preset' : 'presets', room: null };
    case 'webhooks': {
      const kind = WEBHOOK_KINDS[method];
      return kind ? { kind, room: null } : null;
    }
    default:
      return null;
  }
}

/** JSON with sorted keys: the two backends build the same body in a different key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  }
  return JSON.stringify(value);
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * RealtimeKit's REST API as a `fetch` stub that answers by method and URL
 * (never by call order: in conformance mode both backends call it). Install
 * it with `vi.stubGlobal('fetch', rtk.fetch)` and give the routes `RTK_ENV`.
 *
 * State the tests set: how many people each room has live (`live`, default
 * 0: no live session, RealtimeKit's 404), the meeting a create answers,
 * the participant an add answers, a failure status per call kind, the
 * recordings and webhooks RealtimeKit holds. `calls` lists what was asked;
 * `seen(kind, room?)` answers whether a call happened (once per distinct
 * call, as both backends make the same ones).
 */
export function fakeRtkApi() {
  const state = {
    live: new Map<string, number>(),
    defaultLive: 0,
    meetingId: 'rtk_created',
    participant: { id: 'cf_new', token: 'tok_new' },
    failures: new Map<RtkCallKind, number>(),
    recordings: new Map<string, unknown[]>(),
    webhooks: [] as Array<{ id: string; name: string; url: string; events: string[]; enabled: boolean }>,
    calls: [] as RtkCall[],
  };
  // Everything else (the conformance harness's calls to the Rust server among
  // them) goes to the real network stack.
  const realFetch = globalThis.fetch;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (!url.startsWith(RTK_BASE)) return realFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.slice(RTK_BASE.length);
    const found = classify(method, path);
    if (!found) return json(404, { success: false, errors: [{ code: 404, message: `no route ${method} ${path}` }] });
    const text = typeof init?.body === 'string' ? init.body : null;
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    const { room } = found;
    // Ending a meeting is an update to INACTIVE.
    const kind: RtkCallKind = found.kind === 'update' && body?.status === 'INACTIVE' ? 'end' : found.kind;
    state.calls.push({ kind, method, room, path, body });
    const failure = state.failures.get(kind);
    if (failure) return json(failure, { success: false, errors: [{ code: failure, message: `${kind} refused` }] });
    switch (kind) {
      case 'create':
        return json(201, { success: true, data: { id: state.meetingId, title: body?.title, status: 'ACTIVE' } });
      case 'add':
        return json(201, {
          success: true,
          data: { ...state.participant, name: body?.name, custom_participant_id: body?.custom_participant_id },
        });
      case 'live': {
        const live = state.live.get(room ?? '') ?? state.defaultLive;
        if (live === 0) return json(404, { success: false, errors: [{ code: 404, message: 'No active session' }] });
        return json(200, { success: true, data: { status: 'LIVE', live_participants: live } });
      }
      case 'kick-all':
        return json(200, { success: true, data: { kicked_participants_count: 2 } });
      case 'recordings':
        return json(200, { success: true, data: state.recordings.get(room ?? '') ?? [] });
      case 'presets':
        return json(200, {
          success: true,
          data: [
            { name: 'group_call_host_v3' },
            { name: 'group_call_participant_v2' },
            { name: 'group_call_guest_v2' },
            { name: 'group_call_guest_waiting_v2' },
          ],
        });
      case 'webhooks':
        return json(200, { success: true, data: state.webhooks });
      case 'create-webhook':
        return json(201, { success: true, data: { id: 'wh_created', ...body } });
      default:
        return json(200, { success: true, data: {} });
    }
  });
  const distinct = (calls: RtkCall[]) => {
    const seen = new Set<string>();
    return calls.filter((call) => {
      const key = `${call.method} ${call.path} ${canonical(call.body)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  return {
    state,
    fetch,
    /** Reset what was asked and every setting. */
    reset() {
      state.live.clear();
      state.defaultLive = 0;
      state.meetingId = 'rtk_created';
      state.participant = { id: 'cf_new', token: 'tok_new' };
      state.failures.clear();
      state.recordings.clear();
      state.webhooks = [];
      state.calls = [];
    },
    /** The distinct calls of a kind (both backends make the same ones). */
    calls(kind: RtkCallKind): RtkCall[] {
      return distinct(state.calls.filter((call) => call.kind === kind));
    },
    /** Whether a call of `kind` (about `room`, when given) was made. */
    seen(kind: RtkCallKind, room?: string): boolean {
      return state.calls.some((call) => call.kind === kind && (room === undefined || call.room === room));
    },
    /** `[room, participant]` of every participant removal. */
    removed(): Array<[string | null, string]> {
      return distinct(state.calls.filter((call) => call.kind === 'remove')).map((call) => [
        call.room,
        decodeURIComponent(call.path.split('?')[0]!.split('/').pop() ?? ''),
      ]);
    },
    /** The rooms that were emptied (`kick-all`). */
    killed(): Array<string | null> {
      return state.calls.filter((call) => call.kind === 'kick-all').map((call) => call.room);
    },
  };
}

export type FakeRtkApi = ReturnType<typeof fakeRtkApi>;

export function fakeKv(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(
    Object.entries(initial).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
  );
  return {
    store,
    get: async (key: string, type?: string) => {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

export function fakeBucket(initial: Record<string, string | Uint8Array> = {}) {
  const objects = new Map<string, Uint8Array>();
  const toBytes = (v: string | Uint8Array) => (typeof v === 'string' ? new TextEncoder().encode(v) : v);
  for (const [k, v] of Object.entries(initial)) objects.set(k, toBytes(v));

  const body = (bytes: Uint8Array) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

  const bucket = {
    objects,
    async put(key: string, value: string | Uint8Array) {
      objects.set(key, toBytes(value));
    },
    async head(key: string) {
      const bytes = objects.get(key);
      return bytes ? { key, size: bytes.length, httpEtag: `"etag-${key}"` } : null;
    },
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      const slice = options?.range
        ? bytes.slice(options.range.offset, options.range.offset + options.range.length)
        : bytes;
      return {
        key,
        size: bytes.length,
        body: body(slice),
        arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
        text: async () => new TextDecoder().decode(slice),
      };
    },
    async list(options: { prefix?: string } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(options.prefix ?? ''));
      return { objects: keys.map((key) => ({ key })), truncated: false, cursor: undefined };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  return bucket as unknown as R2Bucket & { objects: Map<string, Uint8Array> };
}

/**
 * A Workflow binding whose `create` is a mock: `created` lists the instances
 * it made. In conformance mode the TypeScript run reaches the implementation
 * without the mock recording it, so `created` holds Rust's calls, as the
 * test's response is Rust's.
 */
export function fakeWorkflow<P = unknown>(options: { failWith?: Error } = {}) {
  const create = vi.fn(async (input: { id: string; params: P }) => {
    if (options.failWith) throw options.failWith;
    return { id: input.id };
  });
  const binding = {
    create,
    get: vi.fn(async (id: string) => ({ id })),
    get created(): Array<{ id: string; params: P }> {
      return options.failWith ? [] : create.mock.calls.map(([input]) => input);
    },
  };
  return binding as unknown as Workflow<P> & { created: Array<{ id: string; params: P }> };
}

/** A meeting and one of its sessions, with sensible defaults. */
export async function seedMeetingWithSession(
  db: Database,
  opts: {
    meetingId: string;
    sessionId: string;
    organizerId?: string;
    meeting?: Partial<typeof schema.meetings.$inferInsert>;
    session?: Partial<typeof schema.meetingSessions.$inferInsert>;
  },
) {
  await db.insert(schema.meetings).values({
    id: opts.meetingId,
    title: 'Weekly sync',
    organizerId: opts.organizerId ?? 'user_test_default',
    ...opts.meeting,
  });
  await db.insert(schema.meetingSessions).values({
    id: opts.sessionId,
    meetingId: opts.meetingId,
    startedBy: opts.organizerId ?? 'user_test_default',
    startedByName: 'Host',
    cfAppId: 'rtk_meeting_1',
    status: 'ended',
    duration: 1800,
    ...opts.session,
  });
}

/**
 * A REALTIME service binding that records every publish body (`topic`, `event`,
 * `data`, ...), so a test can assert what was announced, e.g. `call_superseded`.
 */
export function fakeRealtime() {
  const published: Array<{ workspaceId: string; topic: string; event: string; data: Record<string, unknown> }> = [];
  const fetch = async (_url: unknown, init?: RequestInit) => {
    published.push(JSON.parse(String(init?.body)));
    return new Response('{}');
  };
  return { published, binding: { fetch } as unknown as Fetcher };
}

/** A channel with one ACTIVE WeldChat call that `userId` is in (plus `otherUserId`, when given). */
export async function seedActiveChatCall(
  db: Database,
  opts: { userId: string; cfAppId: string; cfSessionId: string; otherUserId?: string },
) {
  const channelId = `ch_${opts.cfAppId}`.slice(0, 30);
  const callId = `call_${opts.cfAppId}`.slice(0, 30);
  const joinedAt = new Date(Date.now() - 60_000).toISOString();
  const entry = (userId: string, cfSessionId: string) => ({
    userId,
    userName: userId,
    joinedAt,
    cfSessionId,
    hasAudio: false,
    hasVideo: false,
    hasScreenShare: false,
  });
  await db.insert(schema.chatChannels).values({
    id: channelId,
    name: channelId,
    slug: channelId,
    type: 'public',
  } as typeof schema.chatChannels.$inferInsert);
  await db.insert(schema.chatCalls).values({
    id: callId,
    channelId,
    callType: 'voice',
    status: 'active',
    cfAppId: opts.cfAppId,
    initiatorId: opts.userId,
    initiatorName: opts.userId,
    participants: [
      entry(opts.userId, opts.cfSessionId),
      ...(opts.otherUserId ? [entry(opts.otherUserId, `${opts.cfSessionId}_other`)] : []),
    ],
    maxParticipants: 2,
    startedAt: new Date(Date.now() - 60_000),
  });
  return { channelId, callId };
}
