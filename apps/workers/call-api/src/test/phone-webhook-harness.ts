/**
 * Shared pieces of the WeldDesk phone queue tests (agents, voicemail, menu,
 * click-to-call): signed Telnyx webhooks, a Telnyx stub that answers the Call
 * Control commands and dials, a recording REALTIME binding, and a seeded
 * workspace. Each test file keeps its own `vi.mock` of the database lookups
 * (it must be hoisted in the file) and its own `createTestApp`.
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import { vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { json, type TelnyxCall } from './telnyx-stub';

export const BASE = '/public/webhooks/telnyx';
export const ORG = 'org_queue';
export const API_KEY = 'telnyx-key';

const keys = generateKeyPairSync('ed25519');
export const PUBLIC_KEY = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

export function signedHeaders(raw: string, stamp = String(Math.floor(Date.now() / 1000))) {
  return {
    'Content-Type': 'application/json',
    'telnyx-timestamp': stamp,
    'telnyx-signature-ed25519': sign(null, Buffer.from(`${stamp}|${raw}`), keys.privateKey).toString('base64'),
  };
}

export const encodeState = (state: Record<string, string>) => btoa(JSON.stringify(state));
export const decodeState = (state: unknown): Record<string, string> =>
  JSON.parse(atob(String(state))) as Record<string, string>;

export function callEvent(eventType: string, payload: Record<string, unknown>, occurredAt = '2026-10-10T10:00:00Z') {
  return {
    data: { event_type: eventType, id: `ev-${eventType}`, occurred_at: occurredAt, payload, record_type: 'event' },
    meta: { attempt: 1 },
  };
}

export const env = () => ({
  TELNYX_PUBLIC_KEY: PUBLIC_KEY,
  TELNYX_API_KEY: API_KEY,
  TELNYX_CONNECTION_ID: 'conn-1',
  TELNYX_SIP_CONNECTION_ID: 'sip-conn-1',
});

/** Deliver a signed event through `request` (a `createTestApp(...).request`). */
export function deliverWith(request: (path: string, init?: RequestInit) => Promise<Response>, event: unknown) {
  const raw = typeof event === 'string' ? event : JSON.stringify(event);
  return request(BASE, { method: 'POST', headers: signedHeaders(raw), body: raw });
}

// ---------------------------------------------------------------------------
// Telnyx
// ---------------------------------------------------------------------------

/** Telnyx commands of one call leg (`POST /calls/{control}/actions/{action}`). */
export const actionCalls = (calls: TelnyxCall[], control: string, action: string) =>
  calls.filter((c) => c.method === 'POST' && c.url.pathname === `/v2/calls/${control}/actions/${action}`);

/** The dials (`POST /v2/calls`) among `calls`. */
export const dialCalls = (calls: TelnyxCall[]) =>
  calls.filter((c) => c.method === 'POST' && c.url.pathname === '/v2/calls');

export interface DialBody {
  connection_id: string;
  to: string;
  from: string;
  timeout_secs: number;
  client_state: string;
}

interface Stub {
  on(method: string, path: string, handler: ((call: TelnyxCall) => Response | Promise<Response>) | Record<string, unknown>): void;
}

const ACTIONS = [
  'answer',
  'hangup',
  'enqueue',
  'playback_start',
  'playback_stop',
  'speak',
  'record_start',
  'bridge',
  'transfer',
  'gather_using_speak',
  'ai_assistant_start',
];

/** Answer every Call Control command of `control` with success. */
export function stubCallActions(telnyx: Stub, control: string) {
  for (const action of ACTIONS) telnyx.on('POST', `/calls/${control}/actions/${action}`, { data: { result: 'ok' } });
}

/**
 * Answer `POST /v2/calls` with a fresh call_control_id per dial. `refuse`
 * makes a dial fail for the `to` addresses it returns true for.
 */
export function stubDial(telnyx: Stub, refuse: (to: string) => boolean = () => false) {
  let n = 0;
  telnyx.on('POST', '/calls', ({ body }) => {
    const to = (body as DialBody).to;
    if (refuse(to)) return json({ errors: [{ detail: 'refused' }] }, 422);
    n += 1;
    for (const action of ACTIONS) telnyx.on('POST', `/calls/cc-leg-${n}/actions/${action}`, { data: { result: 'ok' } });
    return json({ data: { call_control_id: `cc-leg-${n}`, call_leg_id: `leg-${n}`, call_session_id: `sess-leg-${n}` } });
  });
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

export interface PublishedEvent {
  topic: string;
  event: string;
  data: Record<string, unknown>;
}

/** A REALTIME binding that records publishes and answers presence from `setPresence`. */
export function realtimeStub() {
  const published: PublishedEvent[] = [];
  let presence: Record<string, 'online' | 'away' | 'busy'> | null = null;
  const binding = {
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/internal/presence') {
        const asked = url.searchParams.getAll('userId');
        const users: Record<string, string> = {};
        for (const id of asked) if (!presence || presence[id]) users[id] = presence ? presence[id]! : 'online';
        return json({ users });
      }
      const body = JSON.parse(String(init?.body)) as { topic: string; event: string; data: Record<string, unknown> };
      published.push({ topic: body.topic, event: body.event, data: body.data });
      return json({ ok: true });
    }),
  } as unknown as Fetcher;
  return {
    binding,
    published,
    /** `null`: everyone online; otherwise only the listed members are connected. */
    setPresence(next: Record<string, 'online' | 'away' | 'busy'> | null) {
      presence = next;
    },
    inbox(userId: string, event: string) {
      return published.filter((p) => p.topic === `inbox.${userId}` && p.event === event);
    },
    queue() {
      return published.filter((p) => p.topic === 'desk_phone_queue');
    },
  };
}

// ---------------------------------------------------------------------------
// The workspace
// ---------------------------------------------------------------------------

export const NUMBERS = {
  agents: '+31201270001',
  team: '+31201270002',
  voicemail: '+31201270003',
  menu: '+31201270004',
  hangup: '+31201270005',
  empty: '+31201270006',
  norecord: '+31201270007',
  dutch: '+31201270008',
} as const;

export async function seedPhoneWorkspace(db: Database, master: Awaited<ReturnType<typeof createMasterPgliteDb>>['db']) {
  await master.insert(masterSchema.workspaces).values({
    id: 'ws_queue',
    clerkOrgId: ORG,
    name: 'Queue',
    slug: 'queue',
  } as typeof masterSchema.workspaces.$inferInsert);

  const kinds = Object.keys(NUMBERS) as Array<keyof typeof NUMBERS>;
  await db.insert(schema.voipPhoneNumbers).values(
    kinds.map((kind) => ({
      id: `vpn_q_${kind}`,
      provider: 'telnyx',
      phoneNumber: NUMBERS[kind],
      countryCode: 'NL',
      status: 'active',
      ...(kind === 'norecord' ? { enableRecording: false } : {}),
    })),
  );
  await master.insert(masterSchema.phoneNumberRegistry).values(
    kinds.map((kind) => ({ phoneNumber: NUMBERS[kind], clerkOrgId: ORG, voipPhoneNumberId: `vpn_q_${kind}` })),
  );

  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_q_anna', userId: 'user_anna', name: 'Anna Agent', email: 'anna@example.test' },
    { id: 'wm_q_bob', userId: 'user_bob', name: 'Bob Agent', email: 'bob@example.test' },
    { id: 'wm_q_cy', userId: 'user_cy', name: 'Cy Away', email: 'cy@example.test' },
  ]);
  await db.insert(schema.deskPhoneAgents).values([
    { userId: 'user_anna', available: true, telnyxCredentialId: 'cred-anna', sipUsername: 'sip_anna' },
    { userId: 'user_bob', available: true, telnyxCredentialId: 'cred-bob', sipUsername: 'sip_bob' },
    { userId: 'user_cy', available: false, telnyxCredentialId: 'cred-cy', sipUsername: 'sip_cy' },
  ]);
  await db.insert(schema.helpdeskDepartments).values([
    { id: 'dept_q_sales', name: 'Sales', agentIds: ['user_bob'] },
    { id: 'dept_q_empty', name: 'Night shift', agentIds: ['user_cy'] },
  ]);
  await db.insert(schema.deskVoiceAgents).values({
    id: 'dva_q_front',
    name: 'Front desk',
    systemPrompt: 'Be kind.',
    telnyxAssistantId: 'asst-q-front',
  });
}

/** The inbound call row dialled to `toNumber` with this call_control_id. */
export async function callOf(db: Database, control: string) {
  const [row] = await db
    .select()
    .from(schema.voipCalls)
    .where(and(eq(schema.voipCalls.providerCallId, control), eq(schema.voipCalls.direction, 'inbound')));
  return row!;
}

export async function legsOf(db: Database, callId: string) {
  return db.select().from(schema.deskPhoneCallLegs).where(eq(schema.deskPhoneCallLegs.callId, callId)).orderBy(schema.deskPhoneCallLegs.userId);
}

export async function messagesOf(db: Database, conversationId: string) {
  return db
    .select()
    .from(schema.deskMessages)
    .where(eq(schema.deskMessages.conversationId, conversationId))
    .orderBy(schema.deskMessages.createdAt);
}

export const setRoute = (
  db: Database,
  kind: keyof typeof NUMBERS,
  action: 'agents' | 'voicemail' | 'menu' | 'hangup',
  options: Record<string, unknown> | null,
) =>
  db
    .insert(schema.deskPhoneRoutes)
    .values({ id: `dpr_q_${kind}`, voipPhoneNumberId: `vpn_q_${kind}`, action, options: options as never })
    .onConflictDoUpdate({ target: schema.deskPhoneRoutes.id, set: { action, options: options as never } });
