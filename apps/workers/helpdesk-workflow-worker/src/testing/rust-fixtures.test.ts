/**
 * Parity fixtures for the Rust port of this worker (`rust/crates/desk-domain`,
 * `workflow` and `assignment_router`), written by the TypeScript code itself.
 *
 * Runs the engine's pure helpers, the AssignmentRouter, every registered step
 * handler and whole ConversationWorkflow runs (through `/event` and
 * `/respond`) on pglite, and records what they did: results, the rows they
 * left, the realtime publishes, the Discord and Slack calls and the steps a
 * run took. `rust/crates/desk-domain/tests/workflow_parity.rs` seeds the same
 * rows into Postgres, runs the Rust code on the same input and compares.
 *
 *   pnpm rust:desk-workflow-fixtures          write the fixtures
 *   pnpm --filter helpdesk-workflow-worker test   fails when one is stale
 *
 * Values that differ on every run are placeholders on both sides: generated
 * ids (`<id:msg>`), instance ids (`<instance>`), times written now (`<ts>`) and
 * realtime `ts` stamps (`<ms>`). Seeded times (2026-10-0[1-3] 09:00) stay.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createPgliteDb, pgliteClientOf } from '@weldsuite/worker-kit/testing/pglite';
import { pickDeskAssignee, type DeskPickerState, type DeskPickRequest } from '@weldsuite/db/lib/desk-assignment';
import { evaluateCondition, resolveConversationId, resolveInputs } from '../lib/workflow-shared';
import { executeStepHandler } from '../workflows/step-executor';
import { workflowMatches, type ConversationWorkflowParams } from '../workflows/conversation-workflow';
import {
  AGENTS,
  ARTICLES,
  CLEAR,
  CONVERSATION,
  CONVERSATION_DISCORD,
  SLACK,
  onCreated,
  workflowRow,
  executionRow,
} from './seed';
import { fakeDurableNamespace, fakeRealtime, post, requestUrl, runInstance, testEnv } from './harness';
import type { Env } from '../types';

const holder = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getTenantDbForWorkspace: async () => holder.db,
}));

import worker from '../index';

const OUT_DIR = path.resolve(import.meta.dirname, '../../../../../rust/crates/desk-domain/tests/fixtures');
const WRITE = process.env.WRITE_RUST_FIXTURES === '1';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const SEEDED = /^2026-10-0[1-3][T ]09:00:00/;
const GENERATED = /^(wex|msg|csat)_[0-9a-z]+$/;
const INSTANCE = /^wfi_[0-9a-z]+$/;

/** Placeholders for what changes on every run; object keys sorted. */
export function normalise(value: unknown, key = ''): Json {
  if (value === undefined) return null;
  if (value instanceof Date) return normalise(value.toISOString(), key);
  if (Array.isArray(value)) return value.map((item) => normalise(item));
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      out[k] = normalise(v, k);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (GENERATED.test(value)) return `<id:${value.split('_')[0]}>`;
    if (INSTANCE.test(value)) return '<instance>';
    if (ISO.test(value) && !SEEDED.test(value)) return '<ts>';
    return value;
  }
  if (typeof value === 'number' && key === 'ts') return '<ms>';
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value as Json;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

let client: PGlite;

/** The tables a scenario's outcome is read from, rows sorted by their normalised JSON. */
const DUMPED = [
  'helpdesk_conversations',
  'helpdesk_conversation_messages',
  'helpdesk_workflow_executions',
  'helpdesk_satisfaction_surveys',
  'helpdesk_agents',
] as const;

async function seed(statements: string[]): Promise<void> {
  for (const statement of [...CLEAR, ...statements]) await client.exec(statement);
}

async function dump(): Promise<Record<string, Json[]>> {
  const out: Record<string, Json[]> = {};
  for (const table of DUMPED) {
    const { rows } = await client.query<{ row: unknown }>(`select to_jsonb(t) as row from ${table} t`);
    out[table] = rows
      .map((r) => normalise(r.row))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return out;
}

/**
 * What a scenario changed, per table: the rows it left that were not there
 * after seeding (`added`, new or changed rows) and the seeded rows no longer
 * there (`removed`). Tables it did not touch are left out.
 */
function changes(before: Record<string, Json[]>, after: Record<string, Json[]>): Json {
  const out: Record<string, Json> = {};
  for (const table of DUMPED) {
    const was = new Set(before[table]!.map((row) => JSON.stringify(row)));
    const now = new Set(after[table]!.map((row) => JSON.stringify(row)));
    const added = after[table]!.filter((row) => !was.has(JSON.stringify(row)));
    const removed = before[table]!.filter((row) => !now.has(JSON.stringify(row)));
    if (added.length || removed.length) out[table] = { added, removed };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Outbound HTTP (Discord, Slack)
// ---------------------------------------------------------------------------

interface HttpCall {
  method: string;
  url: string;
  headers: [string, string][];
  body: Json;
}

let httpCalls: HttpCall[] = [];

function stubFetch() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const headers = Object.entries((init?.headers ?? {}) as Record<string, string>);
    httpCalls.push({
      method: init?.method ?? 'GET',
      url,
      headers,
      body: init?.body ? (JSON.parse(String(init.body)) as Json) : null,
    });
    if (url.startsWith('https://slack.com/')) return Response.json({ ok: true });
    return new Response('{}', { status: 200 });
  });
}

// ---------------------------------------------------------------------------
// Fixture files
// ---------------------------------------------------------------------------

const written: Record<string, Json> = {};

function emit(name: string, value: Json): void {
  written[name] = value;
}

afterAll(() => {
  if (!WRITE) return;
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, value] of Object.entries(written)) {
    writeFileSync(path.join(OUT_DIR, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }
});

/** The fixture as committed (`null` when there is none yet). */
function committed(name: string): Json {
  const file = path.join(OUT_DIR, `${name}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Json) : null;
}

function check(name: string, value: Json): void {
  emit(name, value);
  if (!WRITE) {
    expect(value, `rust/crates/desk-domain/tests/fixtures/${name}.json is stale: run pnpm rust:desk-workflow-fixtures`).toEqual(
      committed(name),
    );
  }
}

/** Runs `work` with the worker's console output silenced. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => undefined;
  try {
    return await work();
  } finally {
    Object.assign(console, saved);
  }
}

beforeAll(async () => {
  const { db } = await createPgliteDb();
  holder.db = db;
  client = pgliteClientOf(db)!;
  stubFetch();
});

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

const SCOPE = {
  stepResults: {
    ask: { selectedValue: 'billing', count: 3, nested: { deep: 'yes' }, list: ['a', 'b'] },
    gate: { branch: 'true', flag: false, zero: 0, none: null },
  },
  triggerData: { customerName: 'Jane', content: 'Order 12 is late', amount: 120.5, entityType: 'helpdesk_conversation', entityId: 'hc_9', data: { id: 'x1', tags: ['vip', 'new'] } },
  variables: { tier: 'gold', limit: 10 },
};

const RESOLVE_CASES: Array<Record<string, unknown>> = [
  { message: 'Hello {{trigger.customerName}}, about "{{trigger.content}}"' },
  { exact: '{{steps.ask.count}}', exactObject: '{{steps.ask.nested}}', exactMissing: '{{steps.nope.x}}' },
  { mixed: 'n={{steps.ask.count}} list={{steps.ask.list}} obj={{steps.ask.nested}} miss=[{{trigger.nope}}]' },
  { spaced: '{{ variables.tier }}', unknownRef: '{{other.thing}}', partial: '{{trigger.customerName', plain: 'no templates' },
  { nested: { inner: '{{variables.limit}}', deeper: { x: 'tier {{variables.tier}}' } }, list: [{ a: '{{trigger.amount}}' }, 'raw {{trigger.amount}}', 3, null] },
  { numbers: 5, flag: true, nothing: null, falsy: '{{steps.gate.flag}}', zero: '{{steps.gate.zero}}', none: '{{steps.gate.none}}' },
  { deepPath: '{{trigger.data.tags}}', viaArray: '{{steps.ask.list.0}}', contact: '{{contact.email}}' },
];

const CONDITION_CASES: Array<Record<string, unknown>> = [
  { field: 'steps.gate.branch', operator: 'eq', value: 'true' },
  { field: 'steps.gate.branch', operator: 'equals', value: true },
  { field: 'steps.ask.count', operator: 'neq', value: 3 },
  { field: 'steps.ask.count', operator: 'not_equals', value: '3' },
  { field: 'trigger.amount', operator: 'gt', value: '100' },
  { field: 'trigger.amount', operator: 'greater_than', value: 120.5 },
  { field: 'trigger.amount', operator: 'gte', value: 120.5 },
  { field: 'trigger.amount', operator: 'lt', value: 'abc' },
  { field: 'variables.limit', operator: 'lte', value: 10 },
  { field: 'variables.limit', operator: 'less_than_or_equals', value: '9' },
  { field: 'trigger.content', operator: 'contains', value: 'late' },
  { field: 'trigger.content', operator: 'starts_with', value: 'Order' },
  { field: 'trigger.content', operator: 'ends_with', value: 'early' },
  { field: 'trigger.nope', operator: 'contains', value: 'undefined' },
  { field: 'steps.gate.none', operator: 'exists' },
  { field: 'steps.gate.zero', operator: 'exists' },
  { field: 'steps.gate.none', operator: 'not_exists' },
  { field: 'trigger.missing', operator: 'not_exists' },
  { field: 'variables.tier', operator: 'in', value: ['gold', 'silver'] },
  { field: 'variables.tier', operator: 'in', value: 'gold' },
  { field: 'variables.tier', operator: 'not_in', value: ['bronze'] },
  { field: 'variables.tier', operator: 'not_in', value: 'gold' },
  { field: 'trigger.content', operator: 'matches', value: '^Order \\d+' },
  { field: 'trigger.content', operator: 'matches', value: 'late$' },
  { field: 'literal text', operator: 'eq', value: 'literal text' },
  { field: 'steps.ask.list', operator: 'contains', value: 'a,b' },
  { field: 'steps.ask.nested', operator: 'contains', value: 'object' },
  { field: 'trigger.amount', operator: 'between', value: 1 },
  { field: '', operator: 'eq', value: '' },
  { field: 'trigger.amount', operator: '' },
  { field: 'trigger.amount', operator: 'eq', value: 120.5 },
  { field: 'steps.gate.flag', operator: 'eq', value: false },
];

const CONVERSATION_ID_CASES: Array<{ inputs: Record<string, unknown>; triggerData: unknown }> = [
  { inputs: { conversationId: 'hc_in' }, triggerData: {} },
  { inputs: { conversationId: 42 }, triggerData: {} },
  { inputs: {}, triggerData: { entityType: 'helpdesk_conversation', entityId: 'hc_ev' } },
  { inputs: {}, triggerData: { entityType: 'helpdesk_conversation', entityId: 7 } },
  { inputs: {}, triggerData: { data: { conversationId: 'hc_data' } } },
  { inputs: {}, triggerData: { data: { id: 'hc_id' } } },
  { inputs: {}, triggerData: { data: { other: 1 } } },
  { inputs: { conversationId: '' }, triggerData: null },
];

const TRIGGER = (config: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({
  type: 'entity_event',
  isEnabled: true,
  ...(config === undefined ? {} : { config }),
  ...extra,
});

const TRIGGER_CASES: Array<{ triggers: unknown; params: Partial<ConversationWorkflowParams> }> = [
  { triggers: [TRIGGER({ entityType: 'helpdesk_conversation', eventType: 'created' })], params: { eventType: 'conversation_created', channel: 'chat' } },
  { triggers: [TRIGGER({ entityType: 'helpdesk_conversation' })], params: { eventType: 'conversation_created', channel: 'chat' } },
  { triggers: [TRIGGER({ entityType: 'helpdesk_conversation', eventType: 'status_changed' })], params: { eventType: 'conversation_created', channel: 'chat' } },
  { triggers: [TRIGGER({ entityType: 'helpdesk_conversation', eventType: 'created', channels: ['chat'] })], params: { eventType: 'conversation_created', channel: 'web' } },
  { triggers: [TRIGGER({ entityType: 'helpdesk_conversation', eventType: 'created', channels: [] })], params: { eventType: 'conversation_created', channel: 'web' } },
  { triggers: [TRIGGER({ entityType: 'helpdesk_conversation', eventType: 'message_received' })], params: { eventType: 'message_received', channel: 'web' } },
  { triggers: [TRIGGER({ entityType: 'helpdesk_conversation', eventType: 'first_message' })], params: { eventType: 'message_received', channel: 'web' } },
  { triggers: [TRIGGER({ entityType: 'helpdesk_conversation_message' })], params: { eventType: 'message_received', channel: 'web' } },
  { triggers: [TRIGGER({ entityType: 'helpdesk_conversation_message', eventType: 'updated' })], params: { eventType: 'message_received', channel: 'web' } },
  { triggers: [TRIGGER({ entityType: 'helpdesk_conversation', eventType: 'created' })], params: { eventType: 'message_received', channel: 'web' } },
  { triggers: [TRIGGER({ entityType: 'anything' })], params: { eventType: 'sla_breach' as never, channel: 'web' } },
  { triggers: [TRIGGER(undefined)], params: { eventType: 'conversation_created', channel: 'web' } },
  { triggers: [TRIGGER({ entityType: 'helpdesk_conversation' }, { isEnabled: false })], params: { eventType: 'conversation_created', channel: 'web' } },
  { triggers: [TRIGGER({ entityType: 'helpdesk_conversation' }, { type: 'schedule' })], params: { eventType: 'conversation_created', channel: 'web' } },
  { triggers: null, params: { eventType: 'conversation_created', channel: 'web' } },
  { triggers: [TRIGGER({ entityType: 'x' }), TRIGGER({ entityType: 'helpdesk_conversation' })], params: { eventType: 'conversation_created', channel: 'web' } },
  { triggers: [], params: { eventType: 'conversation_created', channel: 'web', workflowIds: ['hwfl_a'] } },
  { triggers: [TRIGGER({ entityType: 'helpdesk_conversation' })], params: { eventType: 'conversation_created', channel: 'web', workflowIds: ['hwfl_b'] } },
];

describe('fixtures: pure helpers', () => {
  it('template resolution, conditions, conversation ids and trigger matching', () => {
    const resolve = RESOLVE_CASES.map((inputs) => ({
      inputs: inputs as Json,
      out: normalise(resolveInputs(inputs, SCOPE.stepResults, SCOPE.triggerData, SCOPE.variables, {})),
    }));
    const conditions = CONDITION_CASES.map((condition) => ({
      condition: condition as Json,
      met: evaluateCondition(condition, SCOPE.stepResults, SCOPE.triggerData, SCOPE.variables, {}),
    }));
    const conversationIds = CONVERSATION_ID_CASES.map((c) => ({
      inputs: c.inputs as Json,
      triggerData: c.triggerData as Json,
      out: resolveConversationId(c.inputs, c.triggerData),
    }));
    const triggers = TRIGGER_CASES.map((c) => ({
      triggers: c.triggers as Json,
      params: c.params as Json,
      matches: workflowMatches({ id: 'hwfl_a', triggers: c.triggers }, c.params as ConversationWorkflowParams),
    }));
    check('workflow_shared', {
      scope: SCOPE as unknown as Json,
      resolve,
      conditions,
      conversationIds,
      triggers,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. AssignmentRouter
// ---------------------------------------------------------------------------

const ROSTER = (open: Record<string, number>) => Object.entries(open).map(([userId, n]) => ({ userId, open: n }));

const PICK_SEQUENCES: Array<{ name: string; picks: Array<{ now: number; request: DeskPickRequest }> }> = [
  {
    name: 'round robin rotates past the last pick',
    picks: [0, 1000, 2000, 3000, 4000].map((now) => ({
      now,
      request: { mode: 'round_robin', candidates: ROSTER({ user_cy: 0, user_ann: 5, user_bob: 1 }), maxOpen: null },
    })),
  },
  {
    name: 'round robin when the last pick left the roster',
    picks: [
      { now: 0, request: { mode: 'round_robin', candidates: ROSTER({ user_bob: 0, user_cy: 0 }), maxOpen: null } },
      { now: 10, request: { mode: 'round_robin', candidates: ROSTER({ user_ann: 0, user_cy: 0, user_dee: 0 }), maxOpen: null } },
      { now: 20, request: { mode: 'round_robin', candidates: ROSTER({ user_ann: 0 }), maxOpen: null } },
    ],
  },
  {
    name: 'balanced counts recent picks, which expire after 30 s',
    picks: [
      { now: 0, request: { mode: 'balanced', candidates: ROSTER({ user_ann: 1, user_bob: 1, user_cy: 2 }), maxOpen: null } },
      { now: 5_000, request: { mode: 'balanced', candidates: ROSTER({ user_ann: 1, user_bob: 1, user_cy: 2 }), maxOpen: null } },
      { now: 10_000, request: { mode: 'balanced', candidates: ROSTER({ user_ann: 1, user_bob: 1, user_cy: 2 }), maxOpen: null } },
      { now: 29_999, request: { mode: 'balanced', candidates: ROSTER({ user_ann: 1, user_bob: 1, user_cy: 2 }), maxOpen: null } },
      { now: 40_001, request: { mode: 'balanced', candidates: ROSTER({ user_ann: 1, user_bob: 1, user_cy: 2 }), maxOpen: null } },
    ],
  },
  {
    name: 'the cap counts recent picks; nobody left gives null and keeps the pointer',
    picks: [
      { now: 0, request: { mode: 'round_robin', candidates: ROSTER({ user_ann: 1, user_bob: 2 }), maxOpen: 2 } },
      { now: 1, request: { mode: 'round_robin', candidates: ROSTER({ user_ann: 1, user_bob: 2 }), maxOpen: 2 } },
      { now: 2, request: { mode: 'balanced', candidates: [], maxOpen: null } },
      { now: 30_001, request: { mode: 'round_robin', candidates: ROSTER({ user_ann: 1, user_bob: 2 }), maxOpen: 2 } },
    ],
  },
  {
    name: 'ids order as localeCompare does',
    picks: [0, 1, 2, 3, 4, 5].map((now) => ({
      now,
      request: { mode: 'round_robin', candidates: ROSTER({ user_B: 0, user_a: 0, user_2: 0, 'user-x': 0, user_A: 0, user_b: 0 }), maxOpen: null },
    })),
  },
];

const DEPARTMENT_AGENTS = [
  { agentId: 'a1', userId: 'u1', name: 'Zed', maxActive: 2, currentActive: 0, isOnline: true, isAvailable: true, extra: 'kept' },
  { agentId: 'a2', userId: 'u2', name: 'amy', maxActive: 1, currentActive: 0, isOnline: true, isAvailable: true },
  { agentId: 'a3', userId: 'u3', name: 'Bea', maxActive: 3, currentActive: 1, isOnline: false, isAvailable: true },
  { agentId: 'a4', userId: 'u4', name: 'Cal', maxActive: 3, currentActive: 0, isOnline: true, isAvailable: false },
];

const DEPARTMENT_OPS: Array<Record<string, unknown>> = [
  { op: 'assign', departmentId: 'dep_1', mode: 'round_robin' },
  { op: 'release', departmentId: 'dep_1', agentId: 'a1' },
  { op: 'sync', departmentId: 'dep_1', agents: DEPARTMENT_AGENTS },
  { op: 'assign', departmentId: 'dep_1', mode: 'round_robin' },
  { op: 'assign', departmentId: 'dep_1', mode: 'round_robin' },
  { op: 'assign', departmentId: 'dep_1', mode: 'round_robin' },
  { op: 'assign', departmentId: 'dep_1', mode: 'least_busy' },
  { op: 'release', departmentId: 'dep_1', agentId: 'a2' },
  { op: 'release', departmentId: 'dep_1', agentId: 'a2' },
  { op: 'release', departmentId: 'dep_1', agentId: 'zz' },
  { op: 'sync', departmentId: 'dep_1', agents: [{ ...DEPARTMENT_AGENTS[0], currentActive: 0, maxActive: 5 }, { agentId: 'a9', userId: 'u9', name: 'New', maxActive: 1, currentActive: 0, isOnline: true, isAvailable: true }] },
  { op: 'assign', departmentId: 'dep_1', mode: 'least_busy' },
  { op: 'assign', departmentId: 'dep_1', mode: 'other' },
  { op: 'assign', departmentId: 'dep_2', mode: 'least_busy' },
];

const DEPARTMENT_PATHS: Record<string, string> = { assign: '/assign', release: '/release', sync: '/sync-agents' };

describe('fixtures: AssignmentRouter', () => {
  it('desk picks and the department router', async () => {
    const desk = PICK_SEQUENCES.map(({ name, picks }) => {
      let state: DeskPickerState = { lastUserId: null, recent: [] };
      const steps = picks.map(({ now, request }) => {
        const result = pickDeskAssignee(state, request, now);
        state = result.state;
        return { now, request: request as unknown as Json, userId: result.userId, state: state as unknown as Json };
      });
      return { name, picks: steps };
    });

    const { namespace, objects } = fakeDurableNamespace();
    const env = { ...testEnv().env, ASSIGNMENT_ROUTER: namespace } as Env;
    const department = [];
    for (const op of DEPARTMENT_OPS) {
      const path = DEPARTMENT_PATHS[String(op.op)] ?? '/sync-agents';
      const { op: _op, ...body } = op;
      const res = await worker.fetch(post(path, body), env);
      const stored = objects.get(String(op.departmentId))?.storage.map.get('state') ?? null;
      department.push({ op: op as Json, status: res.status, body: (await res.json()) as Json, state: normalise(stored) });
    }
    check('assignment_router', { desk, department });
  });
});

// ---------------------------------------------------------------------------
// 3. Step handlers
// ---------------------------------------------------------------------------

interface HandlerCase {
  name: string;
  seed?: string[];
  step: Record<string, unknown>;
  conversationId?: string;
  triggerData?: Record<string, unknown>;
  stepResults?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  /** Run without a REALTIME binding. */
  noRealtime?: boolean;
}

const BASE_SEED = [CONVERSATION, CONVERSATION_DISCORD, AGENTS, ARTICLES];

const HANDLER_CASES: HandlerCase[] = [
  { name: 'send_message with a template', step: { id: 's1', type: 'send_message', name: 'Hi', inputs: { message: 'Hello {{trigger.customerName}}' } }, triggerData: { customerName: 'Jane' } },
  { name: 'send_message from config, inputs win', step: { id: 's1', type: 'send_message', name: 'Hi', config: { message: 'from config', extra: 1 }, inputs: { message: 'from inputs' } } },
  { name: 'send_message without text is skipped', step: { id: 's1', type: 'send_message', name: 'Hi', inputs: {} } },
  { name: 'send_choices', step: { id: 'ask', type: 'send_choices', name: 'Ask', inputs: { message: 'Pick one', options: [{ id: 'o1', label: 'Billing', value: 'billing' }, { label: 'Other', value: 'other' }, { value: 3 }] } } },
  { name: 'send_choices without options', step: { id: 'ask', type: 'send_choices', name: 'Ask', inputs: {} } },
  { name: 'collect_input', step: { id: 'form', type: 'collect_input', name: 'Form', inputs: { message: 'Your details', fields: [{ id: 'email', label: 'Email', type: 'email', required: true }] } } },
  { name: 'suggest_articles by query', step: { id: 'kb', type: 'suggest_articles', name: 'KB', inputs: { query: '  password ' } } },
  { name: 'suggest_articles escapes like wildcards', step: { id: 'kb', type: 'suggest_articles', name: 'KB', inputs: { searchTerm: '100%' } } },
  { name: 'suggest_articles without a query, limited', step: { id: 'kb', type: 'suggest_articles', name: 'KB', inputs: { limit: 1 } } },
  { name: 'add_internal_note on another conversation', step: { id: 'n', type: 'add_internal_note', name: 'Note', inputs: { content: 'Escalated', conversationId: 'hc_2' } } },
  { name: 'add_internal_note from the trigger entity', step: { id: 'n', type: 'add_internal_note', name: 'Note', inputs: {} }, triggerData: { entityType: 'helpdesk_conversation', entityId: 'hc_2' } },
  { name: 'ai_auto_reply escalates', step: { id: 'ai', type: 'ai_auto_reply', name: 'AI', inputs: {} } },
  { name: 'ai_agent is ai_auto_reply', step: { id: 'ai', type: 'ai_agent', name: 'AI', inputs: {} } },
  { name: 'assign to a specific agent', step: { id: 'as', type: 'assign_conversation', name: 'Assign', inputs: { strategy: 'specific_agent', agentId: 'user_ann', agentName: 'Ann' } } },
  { name: 'assign to a specific agent without a name', step: { id: 'as', type: 'assign_conversation', name: 'Assign', inputs: { agentId: 'user_bob' } } },
  { name: 'assign to the current assignee posts no handoff', seed: [`update helpdesk_conversations set assignee_id = 'user_ann' where id = 'hc_1'`], step: { id: 'as', type: 'assign_conversation', name: 'Assign', inputs: { agentId: 'user_ann', agentName: 'Ann' } } },
  { name: 'assign round robin in a department', step: { id: 'as', type: 'assign_conversation', name: 'Assign', inputs: { strategy: 'round_robin', departmentId: 'dep_1' } } },
  { name: 'assign least busy', step: { id: 'as', type: 'assign_conversation', name: 'Assign', inputs: { strategy: 'least_busy' } } },
  { name: 'assign to a department', step: { id: 'as', type: 'assign_conversation', name: 'Assign', inputs: { strategy: 'department', departmentId: 'dep_2' } } },
  { name: 'assign round robin with nobody', step: { id: 'as', type: 'assign_conversation', name: 'Assign', inputs: { strategy: 'round_robin', departmentId: 'dep_9' } } },
  { name: 'assign with an unknown strategy', step: { id: 'as', type: 'assign_conversation', name: 'Assign', inputs: { strategy: 'magic' } } },
  { name: 'assign without realtime', noRealtime: true, step: { id: 'as', type: 'assign_conversation', name: 'Assign', inputs: { agentId: 'user_cy', agentName: 'Cy' } } },
  { name: 'unassign', seed: [`update helpdesk_conversations set assignee_id = 'user_ann', assignee_name = 'Ann', assignee_avatar = 'a.png' where id = 'hc_1'`], step: { id: 'u', type: 'unassign_conversation', name: 'Unassign', inputs: {} } },
  { name: 'close', step: { id: 'c', type: 'close_conversation', name: 'Close', inputs: {} } },
  { name: 'status resolved', step: { id: 'st', type: 'change_conversation_status', name: 'Status', inputs: { status: 'resolved' } } },
  { name: 'status closed', step: { id: 'st', type: 'change_conversation_status', name: 'Status', inputs: { status: 'closed' } } },
  { name: 'status snoozed', step: { id: 'st', type: 'change_conversation_status', name: 'Status', inputs: { status: 'snoozed', snoozeDurationMinutes: '30' } } },
  { name: 'status pending', step: { id: 'st', type: 'change_conversation_status', name: 'Status', inputs: { status: 'pending' } } },
  { name: 'status of a missing conversation', conversationId: 'hc_none', step: { id: 'st', type: 'change_conversation_status', name: 'Status', inputs: { status: 'open' } } },
  { name: 'priority', step: { id: 'p', type: 'change_priority', name: 'Priority', inputs: { priority: 'urgent' } } },
  { name: 'priority without a value', step: { id: 'p', type: 'change_priority', name: 'Priority', inputs: {} } },
  { name: 'tag add', step: { id: 't', type: 'tag_conversation', name: 'Tag', inputs: { tags: ['new', 'vip', 7] } } },
  { name: 'tag remove', step: { id: 't', type: 'tag_conversation', name: 'Tag', inputs: { mode: 'remove', tags: ['vip'] } } },
  { name: 'tag replace', step: { id: 't', type: 'tag_conversation', name: 'Tag', inputs: { mode: 'replace', tags: ['only'] } } },
  { name: 'tag with an unknown mode adds', step: { id: 't', type: 'tag_conversation', name: 'Tag', inputs: { mode: 'merge', tags: 'not-a-list' } } },
  { name: 'tag a conversation without tags', conversationId: 'hc_2', step: { id: 't', type: 'tag_conversation', name: 'Tag', inputs: { tags: ['a', 'a'] } } },
  { name: 'csat', step: { id: 'cs', type: 'trigger_csat', name: 'CSAT', inputs: {} } },
  { name: 'csat for a conversation without a contact', conversationId: 'hc_2', step: { id: 'cs', type: 'trigger_csat', name: 'CSAT', inputs: {} } },
  { name: 'delay', step: { id: 'd', type: 'delay', name: 'Wait', inputs: { duration: 0.005 } } },
  { name: 'delay in seconds', step: { id: 'd', type: 'delay', name: 'Wait', inputs: { delaySeconds: '0.002' } } },
  { name: 'condition from inputs', step: { id: 'cond', type: 'condition', name: 'If', inputs: { field: 'trigger.amount', operator: 'gt', value: 100 } }, triggerData: { amount: 120 } },
  { name: 'condition on a step result', step: { id: 'cond', type: 'condition', name: 'If', inputs: { field: 'steps.ask.selectedValue', operator: 'eq', value: 'other' } }, stepResults: { ask: { selectedValue: 'billing' } } },
  { name: 'condition on a variable', step: { id: 'cond', type: 'condition', name: 'If', inputs: { field: 'variables.tier', operator: 'exists' } }, variables: { tier: 'gold' } },
  { name: 'condition without field', step: { id: 'cond', type: 'condition', name: 'If', inputs: {} } },
  { name: 'a step whose condition fails is skipped', step: { id: 's1', type: 'send_message', name: 'Hi', inputs: { message: 'x' }, condition: { field: 'trigger.amount', operator: 'gt', value: 500 } }, triggerData: { amount: 120 } },
  { name: 'a step whose condition holds runs', step: { id: 's1', type: 'send_message', name: 'Hi', inputs: { message: 'big {{trigger.amount}}' }, condition: { field: 'trigger.amount', operator: 'gt', value: 100 } }, triggerData: { amount: 120 } },
  { name: 'a condition step with its own gate', step: { id: 'cond', type: 'condition', name: 'If', condition: { field: 'trigger.amount', operator: 'lt', value: 500 } }, triggerData: { amount: 120 } },
  { name: 'an unknown step type is skipped', step: { id: 'x', type: 'send_notification', name: 'Notify', inputs: {} } },
];

describe('fixtures: step handlers', () => {
  it('each registered handler on pglite', async () => {
    const out = [];
    for (const c of HANDLER_CASES) {
      await seed([...BASE_SEED, ...(c.seed ?? [])]);
      const before = await dump();
      const realtime = fakeRealtime();
      const env = { ENVIRONMENT: 'test', ...(c.noRealtime ? {} : { REALTIME: realtime.binding }) } as unknown as Env;
      const conversationId = c.conversationId ?? 'hc_1';
      const outcome = await quietly(() =>
        executeStepHandler(c.step as never, {
          db: holder.db as never,
          env,
          conversationId,
          workspaceId: 'org_1',
          executionId: 'wex_fixture',
          triggerData: c.triggerData ?? {},
          stepResults: c.stepResults ?? {},
          variables: c.variables ?? {},
        }),
      );
      out.push({
        name: c.name,
        input: {
          seed: c.seed ?? [],
          step: c.step,
          conversationId,
          triggerData: c.triggerData ?? {},
          stepResults: c.stepResults ?? {},
          variables: c.variables ?? {},
          realtime: !c.noRealtime,
        } as unknown as Json,
        outcome: normalise(outcome),
        changes: changes(before, await dump()),
        publishes: normalise(realtime.publishes),
      });
    }
    check('workflow_handlers', { seed: [...CLEAR, ...BASE_SEED] as Json, cases: out as Json });
  });
});

// ---------------------------------------------------------------------------
// 4. Whole runs: /event, the ConversationWorkflow, /respond
// ---------------------------------------------------------------------------

type Action =
  | { respond: Record<string, unknown> }
  | { timeout: true }
  | { event: Record<string, unknown> };

interface RunCase {
  name: string;
  seed: string[];
  event: Record<string, unknown>;
  /** What happens each time the run parks in a wait, in order. */
  actions?: Action[];
  discordToken?: boolean;
}

const EVENT = (data: Record<string, unknown> = { channel: 'chat' }, conversationId = 'hc_1') => ({
  type: 'conversation_created',
  conversationId,
  workspaceId: 'org_1',
  data,
});

const RUN_CASES: RunCase[] = [
  {
    name: 'no workflow matches',
    seed: [CONVERSATION, workflowRow({ id: 'hwfl_web', name: 'Web only', triggers: onCreated(['web']), steps: [{ id: 's', type: 'send_message', name: 'x', inputs: { message: 'x' } }] })],
    event: EVENT(),
  },
  {
    name: 'draft and deleted workflows are left out; sort order decides; results are shared',
    seed: [
      CONVERSATION,
      AGENTS,
      workflowRow({ id: 'hwfl_b', name: 'Second', sortOrder: 20, triggers: onCreated(), steps: [
        { id: 'tag', type: 'tag_conversation', name: 'Tag', order: 1, inputs: { tags: ['{{steps.greet.content}}'] } },
        { id: 'prio', type: 'change_priority', name: 'Prio', order: 2, inputs: { priority: 'high' } },
      ] }),
      workflowRow({ id: 'hwfl_a', name: 'First', sortOrder: 10, triggers: onCreated(['chat']), steps: [
        { id: 'assign', type: 'assign_conversation', name: 'Assign', order: 2, inputs: { strategy: 'round_robin', departmentId: 'dep_1' } },
        { id: 'greet', type: 'send_message', name: 'Greet', order: 1, inputs: { message: 'Hi {{trigger.customerName}}' } },
        { id: 'skip', type: 'send_message', name: 'Skip', order: 3, inputs: { message: 'never' }, condition: { field: 'trigger.vip', operator: 'eq', value: true } },
      ] }),
      workflowRow({ id: 'hwfl_draft', name: 'Draft', status: 'draft', triggers: onCreated(), steps: [{ id: 'x', type: 'close_conversation', name: 'x' }] }),
      workflowRow({ id: 'hwfl_gone', name: 'Gone', deleted: true, triggers: onCreated(), steps: [{ id: 'x', type: 'close_conversation', name: 'x' }] }),
    ],
    event: EVENT({ channel: 'chat', customerName: 'Jane' }),
  },
  {
    name: 'a failing step stops its workflow unless it may fail',
    seed: [
      CONVERSATION,
      workflowRow({ id: 'hwfl_fail', name: 'Fails', sortOrder: 1, triggers: onCreated(), steps: [
        { id: 'ai', type: 'ai_auto_reply', name: 'AI', order: 1 },
        { id: 'after', type: 'send_message', name: 'After', order: 2, inputs: { message: 'not sent' } },
      ] }),
      workflowRow({ id: 'hwfl_soft', name: 'Soft', sortOrder: 2, triggers: onCreated(), steps: [
        { id: 'ai2', type: 'ai_agent', name: 'AI', order: 1, continueOnError: true },
        { id: 'csat', type: 'trigger_csat', name: 'CSAT', order: 2 },
        { id: 'close', type: 'close_conversation', name: 'Close', order: 3 },
      ] }),
    ],
    event: EVENT(),
  },
  {
    name: 'choices, an answer, and the chosen branch',
    seed: [
      CONVERSATION,
      workflowRow({ id: 'hwfl_choices', name: 'Triage', triggers: onCreated(), steps: [
        { id: 'ask', type: 'send_choices', name: 'Ask', order: 1, inputs: { message: 'What do you need?', options: [{ label: 'Billing', value: 'billing' }, { label: 'Other', value: 'other' }] } },
        { id: 'b1', type: 'add_internal_note', name: 'Note', order: 2, parentBranchId: 'ask_branch_billing', inputs: { content: 'Billing: {{steps.ask.selectedLabel}}' } },
        { id: 'b0', type: 'send_message', name: 'Ack', order: 1, parentBranchId: 'ask_branch_billing', inputs: { message: 'Billing it is' } },
        { id: 'o1', type: 'add_internal_note', name: 'Note', order: 1, parentBranchId: 'ask_branch_other', inputs: { content: 'Other' } },
        { id: 'bye', type: 'send_message', name: 'Bye', order: 2, inputs: { message: 'Thanks!' } },
      ] }),
    ],
    event: EVENT(),
    actions: [{ respond: { stepId: 'ask', selectedValue: 'billing', selectedLabel: 'Billing' } }],
  },
  {
    name: 'an answer without a choice runs no branch',
    seed: [
      CONVERSATION,
      workflowRow({ id: 'hwfl_choices', name: 'Triage', triggers: onCreated(), steps: [
        { id: 'ask', type: 'send_choices', name: 'Ask', order: 1, inputs: { message: 'Rate us', options: [{ label: 'Good', value: 'good' }] } },
        { id: 'g', type: 'send_message', name: 'G', order: 1, parentBranchId: 'ask_branch_good', inputs: { message: 'Yay' } },
      ] }),
    ],
    event: EVENT(),
    actions: [{ respond: { stepId: 'ask', rating: 4, feedback: 'ok' } }],
  },
  {
    name: 'a form, its answer, then a second question that times out',
    seed: [
      CONVERSATION,
      workflowRow({ id: 'hwfl_form', name: 'Form', triggers: onCreated(), steps: [
        { id: 'form', type: 'collect_input', name: 'Form', order: 1, inputs: { message: 'Details?', fields: [{ id: 'email', label: 'Email', type: 'email', required: true }] } },
        { id: 'echo', type: 'send_message', name: 'Echo', order: 2, inputs: { message: 'Got {{steps.form.submittedData.email}}' } },
        { id: 'again', type: 'send_choices', name: 'Again', order: 3, inputs: { message: 'More?', options: [{ label: 'No', value: 'no' }] } },
        { id: 'end', type: 'send_message', name: 'End', order: 4, inputs: { message: 'never' } },
      ] }),
    ],
    event: EVENT(),
    actions: [{ respond: { stepId: 'form', submittedData: { email: 'jane@example.com' } } }, { timeout: true }],
  },
  {
    name: 'a second event while the run waits is busy; respond without a waiting run is 404',
    seed: [
      CONVERSATION,
      workflowRow({ id: 'hwfl_choices', name: 'Triage', triggers: onCreated(), steps: [
        { id: 'ask', type: 'send_choices', name: 'Ask', order: 1, inputs: { message: 'Pick', options: [{ label: 'A', value: 'a' }] } },
      ] }),
    ],
    event: EVENT(),
    actions: [
      { event: { type: 'message_received', conversationId: 'hc_1', workspaceId: 'org_1', data: { content: 'hello?' } } },
      { respond: { stepId: 'ask', selectedValue: 'a' } },
    ],
  },
  {
    name: 'a delay step and suggested articles on the web channel',
    seed: [
      CONVERSATION,
      ARTICLES,
      workflowRow({ id: 'hwfl_kb', name: 'KB', triggers: onCreated(), steps: [
        { id: 'wait', type: 'delay', name: 'Wait', order: 1, inputs: { duration: 0.003 } },
        { id: 'kb', type: 'suggest_articles', name: 'KB', order: 2, inputs: { query: '{{trigger.content}}' } },
      ] }),
    ],
    event: { type: 'conversation_created', conversationId: 'hc_1', workspaceId: 'org_1', data: { content: 'password' } },
  },
  {
    name: 'discord gets the bot messages',
    discordToken: true,
    seed: [
      CONVERSATION_DISCORD,
      workflowRow({ id: 'hwfl_dc', name: 'Discord', triggers: onCreated(), steps: [
        { id: 'hi', type: 'send_message', name: 'Hi', order: 1, inputs: { message: 'Hello from the bot' } },
        { id: 'kb', type: 'suggest_articles', name: 'KB', order: 2, inputs: {} },
        { id: 'ask', type: 'send_choices', name: 'Ask', order: 3, inputs: { message: 'Pick', options: [{ label: 'A', value: 'a' }] } },
      ] }),
    ],
    event: EVENT({ channel: 'discord' }, 'hc_2'),
    actions: [{ respond: { stepId: 'ask', selectedValue: 'a' } }],
  },
  {
    name: 'discord without a bot token sends nothing',
    seed: [
      CONVERSATION_DISCORD,
      workflowRow({ id: 'hwfl_dc', name: 'Discord', triggers: onCreated(), steps: [
        { id: 'hi', type: 'send_message', name: 'Hi', order: 1, inputs: { message: 'Hello' } },
      ] }),
    ],
    event: EVENT({ channel: 'discord' }, 'hc_2'),
  },
  {
    name: 'slack gets the bot messages in the thread',
    seed: [
      CONVERSATION_DISCORD,
      SLACK,
      workflowRow({ id: 'hwfl_sl', name: 'Slack', triggers: onCreated(), steps: [
        { id: 'hi', type: 'send_message', name: 'Hi', order: 1, inputs: { message: 'Hello from the bot' } },
        { id: 'form', type: 'collect_input', name: 'Form', order: 2, inputs: { message: 'Details', fields: [{ id: 'n', label: 'Name', type: 'text' }] } },
      ] }),
    ],
    event: EVENT({ channel: 'slack' }, 'hc_2'),
    actions: [{ respond: { stepId: 'form', submittedData: { n: 'Bob' } } }],
  },
  {
    name: 'email conversations dispatch nothing',
    seed: [
      CONVERSATION_DISCORD,
      SLACK,
      workflowRow({ id: 'hwfl_em', name: 'Email', triggers: onCreated(), steps: [
        { id: 'hi', type: 'send_message', name: 'Hi', order: 1, inputs: { message: 'Hello' } },
      ] }),
    ],
    event: EVENT({ channel: 'email' }, 'hc_2'),
  },
  {
    name: 'an event while an execution runs is busy',
    seed: [CONVERSATION, workflowRow({ id: 'hwfl_1', name: 'W', triggers: onCreated(), steps: [] }), executionRow({ id: 'wex_seed', workflowId: 'hwfl_1', conversationId: 'hc_1', status: 'running' })],
    event: EVENT(),
  },
];

describe('fixtures: workflow runs', () => {
  it('runs through /event, the workflow and /respond', async () => {
    const out = [];
    for (const c of RUN_CASES) {
      await seed(c.seed);
      const before = await dump();
      httpCalls = [];
      const { env, realtime, workflows } = testEnv(c.discordToken ? { DISCORD_BOT_TOKEN: 'bot-token' } : {});
      const calls: Json[] = [];
      const call = async (pathname: string, body: unknown) => {
        const res = await quietly(() => worker.fetch(post(pathname, body), env));
        const entry = { path: pathname, body: body as Json, status: res.status, response: normalise(await res.json()) };
        calls.push(entry);
        return entry;
      };

      const started = await call('/event', c.event);
      let steps: Json = [];
      let outcome: Json = null;
      if ((started.response as Record<string, Json>).action === 'workflow_started') {
        const instance = workflows.last();
        const run = runInstance(env, instance);
        const settled = run.done.then(
          (value) => ({ ok: normalise(value) }),
          (err: Error) => ({ error: err.message.replace(/waiting for \w+/, 'waiting') }),
        );
        for (const action of c.actions ?? []) {
          const parked = await Promise.race([instance.whenParked().then(() => true), settled.then(() => false)]);
          if (!parked) break;
          if ('timeout' in action) instance.timeOut();
          else if ('event' in action) await call('/event', action.event);
          else {
            const [execution] = (await client.query<{ id: string }>(`select id from helpdesk_workflow_executions where status = 'waiting_for_input'`)).rows;
            await call('/respond', { conversationId: c.event.conversationId, workspaceId: 'org_1', executionId: execution?.id ?? null, ...action.respond });
          }
        }
        outcome = (await quietly(() => settled)) as Json;
        steps = run.step.log as unknown as Json;
        // A late answer, once the run is over (not after a timeout: the
        // execution then still waits, for an instance that errored).
        if (!('error' in (outcome as Record<string, Json>))) await call('/respond', { conversationId: c.event.conversationId, workspaceId: 'org_1', executionId: 'none', stepId: 'late' });
      }
      out.push({
        name: c.name,
        input: { seed: c.seed, event: c.event, actions: (c.actions ?? []) as Json, discordToken: c.discordToken ?? false } as unknown as Json,
        calls: normalise(calls),
        steps,
        outcome,
        changes: changes(before, await dump()),
        publishes: normalise(realtime.publishes),
        http: normalise(httpCalls),
      });
    }
    check('workflow_runs', { clear: CLEAR as Json, cases: out as Json });
  });
});
