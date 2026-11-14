/**
 * RealtimeKit's REST API as a `fetch` stub, for the call tests that run on
 * both backends (conformance): the routes reach it through
 * `@weldsuite/cloudflare-realtime` (TypeScript) or the outbound bridge
 * (Rust), so it answers by method and URL, never by call order. The same
 * shape as meet-api's `src/test/fakes.ts`, cut down to what calls use.
 * Test-only.
 */

import { vi } from 'vitest';

const RTK_ACCOUNT = 'acc_test';
const RTK_APP = 'app_test';
/** Where `@weldsuite/cloudflare-realtime` (the official SDK) sends every call. */
export const RTK_BASE = `https://api.cloudflare.com/client/v4/accounts/${RTK_ACCOUNT}/realtime/kit/${RTK_APP}`;

/**
 * RealtimeKit's credentials, and an `RTK_FETCH` that goes through
 * `globalThis.fetch` at call time, so the conformance harness records the
 * calls and the Rust server reaches the same stub.
 */
export const RTK_ENV = {
  CF_ACCOUNT_ID: RTK_ACCOUNT,
  CF_REALTIME_APP_ID: RTK_APP,
  CF_REALTIME_APP_SECRET: 'rtk_secret_test',
  RTK_FETCH: ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch,
};

/** The KV marker that tells `ensurePresets` the presets are seeded. */
export const RTK_PRESETS_SEEDED = { 'rtk-presets-seeded-v8': '1' };

export type RtkCallKind = 'create' | 'end' | 'add' | 'remove' | 'list' | 'live' | 'kick-all' | 'other';

export interface RtkCall {
  kind: RtkCallKind;
  method: string;
  room: string | null;
  path: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function classify(method: string, path: string, body: Record<string, unknown> | null): { kind: RtkCallKind; room: string | null } {
  const parts = path.split('?')[0]!.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'meetings') return { kind: 'other', room: null };
  const room = parts[1] ?? null;
  const sub = parts.slice(2).join('/');
  if (method === 'POST' && !room) return { kind: 'create', room: null };
  if (method === 'PATCH' && sub === '' && body?.status === 'INACTIVE') return { kind: 'end', room };
  if (method === 'POST' && sub === 'participants') return { kind: 'add', room };
  if (method === 'GET' && sub === 'participants') return { kind: 'list', room };
  if (method === 'DELETE' && parts[2] === 'participants') return { kind: 'remove', room };
  if (method === 'GET' && sub === 'active-session') return { kind: 'live', room };
  if (method === 'POST' && sub === 'active-session/kick-all') return { kind: 'kick-all', room };
  return { kind: 'other', room };
}

/**
 * The stub. Install it with `vi.stubGlobal('fetch', rtk.fetch)` and give the
 * routes `RTK_ENV`. `state.live` sets how many people a room has connected
 * (default 0: no live session, RealtimeKit's 404); `state.liveFails` makes
 * the live check fail (the provider can't be asked).
 */
export function fakeRtkApi() {
  const state = {
    live: new Map<string, number>(),
    liveFails: false,
    calls: [] as RtkCall[],
  };
  const realFetch = globalThis.fetch;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (!url.startsWith(RTK_BASE)) return realFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.slice(RTK_BASE.length);
    const text = typeof init?.body === 'string' ? init.body : null;
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    const { kind, room } = classify(method, path, body);
    state.calls.push({ kind, method, room, path });
    switch (kind) {
      case 'create':
        return json(201, { success: true, data: { id: 'rtk_created', title: body?.title, status: 'ACTIVE' } });
      case 'add':
        return json(201, {
          success: true,
          data: { id: 'cf_new', token: 'tok_new', name: body?.name, custom_participant_id: body?.custom_participant_id },
        });
      case 'list':
        return json(200, { success: true, data: [] });
      case 'live': {
        if (state.liveFails) return json(500, { success: false, errors: [{ code: 500, message: 'down' }] });
        const live = state.live.get(room ?? '') ?? 0;
        if (live === 0) return json(404, { success: false, errors: [{ code: 404, message: 'No active session' }] });
        return json(200, { success: true, data: { status: 'LIVE', live_participants: live } });
      }
      case 'kick-all':
        return json(200, { success: true, data: { kicked_participants_count: 0 } });
      default:
        return json(200, { success: true, data: {} });
    }
  });
  return {
    state,
    fetch,
    reset() {
      state.live.clear();
      state.liveFails = false;
      state.calls = [];
    },
    /** Whether a call of `kind` (about `room`, when given) was made. */
    seen(kind: RtkCallKind, room?: string): boolean {
      return state.calls.some((call) => call.kind === kind && (room === undefined || call.room === room));
    },
  };
}

/** An in-memory KV namespace, shared by the requests of one test. */
export function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
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
