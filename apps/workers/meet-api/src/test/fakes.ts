/**
 * In-memory stand-ins for the Cloudflare bindings meet-api's recording tests need:
 * KV, the private R2 bucket and a Workflow binding. Test-only.
 */

import { schema, type Database } from '@weldsuite/worker-kit/db';

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

export function fakeWorkflow<P = unknown>(options: { failWith?: Error } = {}) {
  const created: Array<{ id: string; params: P }> = [];
  const binding = {
    created,
    async create(input: { id: string; params: P }) {
      if (options.failWith) throw options.failWith;
      created.push(input);
      return { id: input.id };
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
