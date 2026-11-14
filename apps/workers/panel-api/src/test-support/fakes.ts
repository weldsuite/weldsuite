/**
 * Fakes the recordings, people, heatmap, key and AI route tests share: a Basin
 * that answers by what the SQL asks for, the PanelProject Durable Object, an
 * in-memory KV, queues, and an event log that orders what happened across them
 * (erasure's order matters).
 */

import { vi } from 'vitest';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import type {
  PanelErasure,
  PanelLiveSession,
  PanelPeoplePage,
  PanelPerson,
} from '@weldsuite/panel-domain/project-object';
import type { PanelMaintenanceMessage } from '../types';

export const WORKSPACE = 'ws_alpha';
export const PROJECT = 'pnp_a';

/** Order in which the fakes were called, for the tests that care. */
export const callLog: string[] = [];

// ---------------------------------------------------------------------------
// Basin
// ---------------------------------------------------------------------------

type BasinRows = Record<string, unknown>[];
interface BasinRule {
  match: RegExp;
  rows: BasinRows | ((sql: string) => BasinRows);
}

export class FakeBasin {
  readonly sent: string[] = [];
  private rules: BasinRule[] = [];
  status = 200;

  /** The first rule whose pattern matches the statement answers it; unmatched statements get no rows. */
  on(match: RegExp, rows: BasinRule['rows']): this {
    this.rules.push({ match, rows });
    return this;
  }

  reset(): void {
    this.sent.length = 0;
    this.rules = [];
    this.status = 200;
  }

  install(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const { query } = JSON.parse(init.body as string) as { query: string };
        this.sent.push(query);
        callLog.push('basin');
        if (this.status !== 200) return new Response('boom', { status: this.status });
        const rule = this.rules.find((r) => r.match.test(query));
        const rows = rule ? (typeof rule.rows === 'function' ? rule.rows(query) : rule.rows) : [];
        return Response.json({ result: { rows, metrics: { bytes_scanned: 1024 } } });
      }),
    );
  }
}

export const BASIN_ENV = { R2_SQL_API_TOKEN: 'tok', CF_ACCOUNT_ID: 'acc', PANEL_BASIN_BUCKET: 'bucket' };

// ---------------------------------------------------------------------------
// KV, queues, R2
// ---------------------------------------------------------------------------

export function memoryKv(store = new Map<string, string>()): KVNamespace {
  return {
    get: async (key: string, type?: unknown) => {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === 'json' || (type as { type?: string } | undefined)?.type === 'json' ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

export function memoryQueue<T>(into: T[], label: string): Queue<T> {
  return {
    send: async (message: T) => {
      callLog.push(label);
      into.push(message);
    },
  } as unknown as Queue<T>;
}

export function entityQueue(into: EntityEventMessage[]): Queue<EntityEventMessage> {
  return memoryQueue(into, 'entity-event');
}

export function maintenanceQueue(into: PanelMaintenanceMessage[]): Queue<PanelMaintenanceMessage> {
  return memoryQueue(into, 'maintenance');
}

/** An in-memory bucket that logs deletes in {@link callLog}. */
export function replaysBucket(): R2Bucket {
  const bucket = createMemoryR2();
  const del = bucket.delete.bind(bucket);
  bucket.delete = (async (keys: string | string[]) => {
    callLog.push('r2.delete');
    return del(keys);
  }) as R2Bucket['delete'];
  return bucket;
}

export async function gzipBytes(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipText(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const stream = new Blob([bytes as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export function chunkKey(seq: number, session = 'ses_1', opts: { tier?: string; ws?: string; project?: string; day?: string } = {}): string {
  return `${opts.tier ?? '30d'}/${opts.ws ?? WORKSPACE}/${opts.project ?? PROJECT}/${opts.day ?? '2026-11-10'}/${session}/${seq}.json.gz`;
}

// ---------------------------------------------------------------------------
// The PanelProject object
// ---------------------------------------------------------------------------

export function person(userId: string, extra: Partial<PanelPerson> = {}): PanelPerson {
  return {
    userId,
    email: null,
    name: null,
    properties: {},
    anonIds: [],
    firstSeen: '2026-11-01T10:00:00.000Z',
    lastSeen: '2026-11-14T10:00:00.000Z',
    ...extra,
  };
}

export class FakeProjectState {
  people: PanelPerson[] = [];
  erased: string[] = [];
  identified = false;
  liveSessions: PanelLiveSession[] = [];
  eraseCalls: { userIdOrAnonId: string }[] = [];
  /** What `erase` answers for an id; the default erases just that id. */
  eraseResult: ((id: string) => PanelErasure) | null = null;

  reset(): void {
    this.people = [];
    this.erased = [];
    this.identified = false;
    this.liveSessions = [];
    this.eraseCalls = [];
    this.eraseResult = null;
  }

  /** A Durable Object namespace whose object is this state. */
  namespace() {
    const state = this;
    const stub = {
      erasedIds: async () => state.erased,
      hasIdentifiedUsers: async () => state.identified,
      getPerson: async (id: string) => state.people.find((p) => p.userId === id || p.anonIds.includes(id)) ?? null,
      listPeople: async (input: { search?: string; cursor?: string | null; limit: number }): Promise<PanelPeoplePage> => {
        const needle = input.search?.toLowerCase();
        const all = state.people.filter((p) => !needle || [p.userId, p.email, p.name].some((v) => v?.toLowerCase().includes(needle)));
        const start = input.cursor ? Number(input.cursor) : 0;
        const page = all.slice(start, start + input.limit);
        const next = start + input.limit;
        return { people: page, cursor: next < all.length ? String(next) : null, totalCount: all.length };
      },
      findByEmail: async (email: string) => state.people.filter((p) => p.email === email.toLowerCase()),
      live: async () => ({ visitors: state.liveSessions.length, sessions: state.liveSessions }),
      erase: async (input: { userIdOrAnonId: string }): Promise<PanelErasure> => {
        callLog.push('object.erase');
        state.eraseCalls.push({ userIdOrAnonId: input.userIdOrAnonId });
        const result = state.eraseResult ? state.eraseResult(input.userIdOrAnonId) : { userId: null, erasedIds: [input.userIdOrAnonId] };
        state.erased.push(...result.erasedIds);
        state.people = state.people.filter((p) => !result.erasedIds.includes(p.userId));
        return result;
      },
    };
    return {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () => stub,
    };
  }
}

export function sessionRow(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: id,
    started: '2026-11-10 10:00:00',
    ended: '2026-11-10 10:05:00',
    duration_seconds: 300,
    pageviews: 3,
    clicks: 4,
    events: 12,
    rage: 0,
    dead: 0,
    quickback: 0,
    excessive: 0,
    errors: 0,
    entry_page: '/pricing',
    exit_page: '/checkout',
    device: 'desktop',
    browser: 'Chrome',
    os: 'macOS',
    country: 'NL',
    person: 'user_1',
    user_id: 'user_1',
    ...extra,
  };
}

export function eventRow(name: string, ts: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: `evt_${name}_${ts}`,
    name,
    ts,
    path: '/pricing',
    url: 'https://shop.example/pricing',
    title: 'Pricing',
    session_id: 'ses_1',
    el_text: null,
    error_message: null,
    properties: '{}',
    ...extra,
  };
}
