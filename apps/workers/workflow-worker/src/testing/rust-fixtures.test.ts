/**
 * Parity fixtures for the Rust port of this worker's engine
 * (`rust/modules/connect/src/engine`), written by the TypeScript code itself.
 *
 * Runs whole `ExecuteWorkflowWorkflow` runs on pglite with a fake `step`
 * (it runs each `step.do`, records sleeps, and answers `waitForEvent` from
 * the case) and records what they did: the run's result, the execution and
 * step rows, error logs, workflow stats, notifications, realtime publishes,
 * chained runs, third-party calls and the steps the run took.
 * `rust/modules/connect/tests/engine_parity.rs` seeds the same rows into
 * Postgres, runs the Rust engine on the same input and compares.
 *
 *   pnpm rust:connect-engine-fixtures          write the fixtures
 *   pnpm --filter workflow-worker test          fails when one is stale
 *
 * Values that differ on every run are placeholders on both sides: generated
 * ids (`<id:wex>`), times written now (`<ts>`), durations and realtime `ts`
 * stamps (`<n>`). Seeded times (2026-10-0[1-3] 09:00) stay.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

const holder = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getTenantDbForWorkspace: async () => holder.db,
}));

// connect-api's `/api/internal/workflow-actions/*` (the WeldSuite record
// steps) open the workspace's database through worker-kit.
vi.mock('../../../../../packages/core/worker-kit/src/db.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTenantDbForWorkspace: async () => holder.db,
}));

import { ExecuteWorkflowWorkflow, type ExecuteWorkflowParams } from '../index';
import { createPgliteDb } from '../test/pglite';
import type { Database } from '../db';

const OUT_DIR = path.resolve(import.meta.dirname, '../../../../../rust/modules/connect/tests/fixtures');
const WRITE = process.env.WRITE_RUST_FIXTURES === '1';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// ---------------------------------------------------------------------------
// Normalisation (rust/modules/connect/tests/engine_parity.rs mirrors it)
// ---------------------------------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const SEEDED = /^2026-10-0[1-3][T ]09:00:00/;
const GENERATED = /\b(wex|wes|wel|notif|msg)_[0-9A-Za-z]{24}\b/g;
/** `generateId(prefix)`: the prefix, `_`, 16 base-36 characters. */
const GENERATED_SHORT = /\b([a-z]+)_[0-9a-z]{16}\b/g;
const VOLATILE_NUMBERS = new Set(['duration', 'ts', 'durationMs_measured']);

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
  if (typeof value === 'number' && VOLATILE_NUMBERS.has(key)) return '<n>';
  if (typeof value === 'string') {
    if (ISO.test(value) && !SEEDED.test(value)) return '<ts>';
    return value
      .replaceAll(GENERATED, '<id:$1>')
      .replaceAll(GENERATED_SHORT, '<id:$1>')
      .replace(/^Completed in \d+ms/, 'Completed in <n>ms');
  }
  return value as Json;
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

const CLEAR = [
  'delete from workflow_execution_steps',
  'delete from workflow_error_logs',
  'delete from workflow_executions',
  'delete from notifications',
  'delete from workflow_variables',
  'delete from workflows',
  'delete from helpdesk_workflows',
  'delete from workspace_members',
  'delete from crm_activities',
  'delete from crm_opportunities',
  'delete from crm_pipeline_stages',
  'delete from crm_leads',
  'delete from person_companies',
  'delete from people',
  'delete from parties',
  'delete from companies',
  'delete from chat_messages',
  'delete from chat_channel_members',
  'delete from chat_channels',
  'delete from calendar_events',
  'delete from tasks',
  'delete from task_number_sequences',
  'delete from project_members',
  'delete from projects',
];

const MEMBERS = `insert into workspace_members (id, user_id, email, name, role)
  values ('wm_1', 'user_owner', 'owner@example.com', 'Owner', 'OWNER'),
         ('wm_2', 'user_approver', 'ann@example.com', 'Ann', 'MEMBER')`;

const sqlText = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

function workflowRow(
  id: string,
  steps: unknown[],
  over: { status?: string; settings?: unknown; triggers?: unknown; createdBy?: string | null } = {},
) {
  const createdBy = over.createdBy === undefined ? "'user_owner'" : over.createdBy === null ? 'null' : `'${over.createdBy}'`;
  return `insert into workflows (id, created_at, updated_at, name, status, version, created_by, steps, triggers, settings)
    values ('${id}', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z', 'Flow ${id}', '${over.status ?? 'active'}', 3,
    ${createdBy}, ${sqlText(steps)}, ${sqlText(over.triggers ?? [])}, ${sqlText(over.settings ?? {})})`;
}

interface HttpStub {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface Case {
  name: string;
  seed: string[];
  instanceId: string;
  params: ExecuteWorkflowParams;
  /** `waitForEvent` answers by wait name: an event, or `timeout`. */
  events?: Record<string, unknown>;
  /** Third-party answers by URL. */
  http?: Record<string, HttpStub>;
  /** Queries whose rows go into the output (the records the steps wrote). */
  inspect?: string[];
}

const RUN = { workspaceId: 'org_test', userId: 'user_owner' };

const CASES: Case[] = [
  {
    name: 'variables, a passing condition branch and a transform',
    instanceId: 'inst_basic',
    seed: [
      MEMBERS,
      workflowRow('wf_basic', [
        { id: 's1', type: 'set_variable', name: 'Count', config: { name: 'count', value: 3 } },
        { id: 's2', type: 'log', config: { message: '{{variables.greeting}} {{trigger.userId}} {{trigger.source}}' } },
        { id: 's3', type: 'condition', name: 'Big?', config: { field: 'variables.count', operator: 'gt', value: 2 } },
        { id: 's4', type: 'log', parentBranchId: 's3_if', config: { message: 'big' } },
        { id: 's5', type: 'log', parentBranchId: 's3_if_not', config: { message: 'small' } },
        { id: 's6', type: 'transform', config: { transform: 'pick', fields: ['s1', 's2'] } },
      ]),
      `insert into workflow_variables (id, name, value) values ('wvr_1', 'greeting', '"Hello"'::jsonb)`,
    ],
    params: { ...RUN, workflowId: 'wf_basic', triggerType: 'manual', triggerData: { source: 'test' } },
  },
  {
    name: "a step's own condition, and a value-branching condition",
    instanceId: 'inst_branches',
    seed: [
      MEMBERS,
      workflowRow('wf_branches', [
        {
          id: 's1',
          type: 'log',
          condition: { field: 'trigger.priority', operator: 'eq', value: 'high' },
          config: { message: 'urgent' },
        },
        {
          id: 's2',
          type: 'condition',
          config: { field: 'trigger.priority', branches: [{ value: 'low' }, { value: 'default' }] },
        },
        { id: 's3', type: 'log', parentBranchId: 's2_branch_low', config: { message: 'low one' } },
        { id: 's4', type: 'log', parentBranchId: 's2_branch_default', config: { message: 'other' } },
      ]),
    ],
    params: { ...RUN, workflowId: 'wf_branches', triggerType: 'api', triggerData: { priority: 'low' } },
  },
  {
    name: 'a loop whose body step fails on one item and continues',
    instanceId: 'inst_loop',
    seed: [
      MEMBERS,
      workflowRow('wf_loop', [
        { id: 's1', type: 'loop', config: { items: '{{trigger.items}}' } },
        { id: 's2', type: 'log', parentBranchId: 's1_each', config: { message: 'item {{loop.item.name}} #{{loop.index}}' } },
        {
          id: 's3',
          type: 'set_variable',
          parentBranchId: 's1_each',
          continueOnError: true,
          config: { name: '{{loop.item.var}}', value: '{{loop.item.name}}' },
        },
        { id: 's4', type: 'log', config: { message: 'last var {{variables.x}}' } },
      ]),
    ],
    params: {
      ...RUN,
      workflowId: 'wf_loop',
      triggerType: 'manual',
      triggerData: { items: [{ name: 'a', var: 'x' }, { name: 'b' }] },
    },
  },
  {
    name: 'an HTTP request retried with back-off, then the run fails and the owner is told',
    instanceId: 'inst_retry',
    seed: [
      MEMBERS,
      workflowRow('wf_retry', [
        {
          id: 's1',
          type: 'http_request',
          name: 'Call API',
          retryPolicy: { maxAttempts: 2, delayMs: 1000, backoffMultiplier: 2 },
          config: { url: 'https://api.example.com/flaky', method: 'POST', body: { a: 1 } },
        },
        { id: 's2', type: 'log', config: { message: 'never' } },
      ]),
    ],
    params: { ...RUN, workflowId: 'wf_retry', triggerType: 'manual' },
    http: { 'https://api.example.com/flaky': { status: 503, body: { error: 'busy' } } },
  },
  {
    name: 'a webhook answers JSON; an HTTP 404 is not retried',
    instanceId: 'inst_http',
    seed: [
      MEMBERS,
      workflowRow(
        'wf_http',
        [
          { id: 's1', type: 'webhook', config: { url: 'https://hooks.example.com/in', payload: { x: '{{trigger.x}}' } } },
          {
            id: 's2',
            type: 'http_request',
            retryPolicy: { maxAttempts: 3 },
            config: { url: 'https://api.example.com/missing', headers: { 'X-Key': 'k' } },
          },
        ],
        { settings: { notifyOnError: false } },
      ),
    ],
    params: { ...RUN, workflowId: 'wf_http', triggerType: 'webhook', triggerData: { x: 'hello' } },
    http: {
      'https://hooks.example.com/in': { status: 200, body: { ok: true } },
      'https://api.example.com/missing': {
        status: 404,
        body: { message: 'nope' },
        headers: { 'content-type': 'application/json', 'set-cookie': 'a=b', 'x-trace': 't1' },
      },
    },
  },
  {
    name: 'a delay, then a workflow_complete chain with the output and a completion notice',
    instanceId: 'inst_chain',
    seed: [
      MEMBERS,
      workflowRow(
        'wf_first',
        [
          { id: 's1', type: 'delay', config: { seconds: 30 } },
          { id: 's2', type: 'log', config: { message: 'after {{steps.s1.duration}}' } },
        ],
        { settings: { notifyOnComplete: true } },
      ),
      workflowRow('wf_next', [{ id: 'n1', type: 'log', config: { message: 'next' } }], {
        triggers: [{ type: 'workflow_complete', config: { sourceWorkflowId: 'wf_first', triggerOn: 'success', passOutput: true } }],
      }),
      workflowRow('wf_on_failure', [{ id: 'f1', type: 'log', config: { message: 'x' } }], {
        triggers: [{ type: 'workflow_complete', sourceWorkflowId: 'wf_first', triggerOn: 'failure' }],
      }),
    ],
    params: { ...RUN, workflowId: 'wf_first', triggerType: 'manual', chainDepth: 1 },
  },
  {
    name: 'an approval, approved, then the run continues',
    instanceId: 'inst_approve',
    seed: [
      MEMBERS,
      workflowRow('wf_approve', [
        { id: 's1', type: 'manual_step', name: 'Approve', config: { title: 'Ship it?', approverIds: ['user_approver', 'user_gone'] } },
        { id: 's2', type: 'condition', config: { field: 'steps.s1.approved', operator: 'eq', value: true } },
        { id: 's3', type: 'log', parentBranchId: 's2_if', config: { message: 'approved by {{steps.s1.decidedByName}}' } },
      ]),
    ],
    params: { ...RUN, workflowId: 'wf_approve', triggerType: 'manual' },
    events: {
      'wait-input-0': {
        payload: {
          stepId: 's1',
          approved: true,
          decision: 'approved',
          comment: ' ok ',
          decidedBy: 'user_approver',
          decidedByName: 'Ann',
          decidedAt: '2026-10-02T09:00:00.000Z',
        },
      },
    },
  },
  {
    name: 'an approval nobody decides expires',
    instanceId: 'inst_expire',
    seed: [MEMBERS, workflowRow('wf_expire', [{ id: 's1', type: 'manual_step', config: {} }])],
    params: { ...RUN, workflowId: 'wf_expire', triggerType: 'manual' },
    events: { 'wait-input-0': 'timeout' },
  },
  {
    name: 'a test run of a draft keeps no stats',
    instanceId: 'inst_test',
    seed: [MEMBERS, workflowRow('wf_draft', [{ id: 's1', type: 'log', config: { message: 'try' } }], { status: 'draft' })],
    params: { ...RUN, workflowId: 'wf_draft', triggerType: 'manual', isTest: true },
  },
  {
    name: 'an inactive workflow cancels its queued run',
    instanceId: 'inst_paused',
    seed: [
      MEMBERS,
      workflowRow('wf_paused', [{ id: 's1', type: 'log', config: {} }], { status: 'paused' }),
      `insert into workflow_executions (id, created_at, updated_at, workflow_id, workflow_name, status, triggered_by, trigger_type)
        values ('wex_queued_1', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z', 'wf_paused', 'Flow wf_paused', 'queued', 'user_owner', 'manual')`,
    ],
    params: { ...RUN, workflowId: 'wf_paused', triggerType: 'manual', executionId: 'wex_queued_1' },
  },
  {
    name: "a scheduled run's slot and local time",
    instanceId: 'inst_schedule',
    seed: [
      MEMBERS,
      workflowRow('wf_schedule', [
        { id: 's1', type: 'log', config: { message: '{{trigger.scheduledTimeLocal}} / {{trigger.scheduledTime}} / {{trigger.runId}}' } },
      ]),
    ],
    params: {
      workspaceId: 'org_test',
      userId: 'system',
      workflowId: 'wf_schedule',
      triggerType: 'schedule',
      triggerData: { scheduleId: 'sch_1', scheduledTime: '2026-10-02T09:00:30.000Z', timezone: 'Europe/Amsterdam' },
    },
  },
  {
    name: "an entity event's record and previous record",
    instanceId: 'inst_entity',
    seed: [
      MEMBERS,
      workflowRow('wf_entity', [
        { id: 's1', type: 'condition', config: { field: 'trigger.previousRecord.status', operator: 'eq', value: 'open' } },
        { id: 's2', type: 'log', parentBranchId: 's1_if', config: { message: '{{trigger.record.name}} was {{trigger.previousRecord.status}}' } },
      ]),
    ],
    params: {
      ...RUN,
      workflowId: 'wf_entity',
      triggerType: 'entity_event',
      triggerData: {
        entityType: 'company',
        action: 'updated',
        entityId: 'co_1',
        data: { name: 'Acme', status: 'won' },
        changes: { status: { old: 'open', new: 'won' } },
      },
    },
  },
  {
    name: 'an unsupported step type fails the run',
    instanceId: 'inst_unknown',
    seed: [MEMBERS, workflowRow('wf_unknown', [{ id: 's1', type: 'teleport', config: {} }])],
    params: { ...RUN, workflowId: 'wf_unknown', triggerType: 'manual' },
  },
  {
    name: 'a notification to members; a waiting step inside a branch fails',
    instanceId: 'inst_nested',
    seed: [
      MEMBERS,
      workflowRow('wf_nested', [
        { id: 's1', type: 'send_notification', config: { title: 'Hi {{trigger.name}}', body: 'b', userIds: ['user_owner', 'user_x'] } },
        { id: 's2', type: 'condition', config: { field: 'trigger.name', operator: 'isNotEmpty' } },
        { id: 's3', type: 'manual_step', parentBranchId: 's2_if', config: { title: 'Nested' } },
      ]),
    ],
    params: { ...RUN, workflowId: 'wf_nested', triggerType: 'manual', triggerData: { name: 'Ann' } },
  },
  {
    name: "WeldSuite records written as the workflow's owner (customer, contact, lead, deal, activity, chat, task)",
    instanceId: 'inst_records',
    seed: [
      MEMBERS,
      `insert into crm_pipeline_stages (id, name, pipeline, position, is_won, is_lost, probability)
        values ('stg_open', 'Open', 'default', 0, false, false, 20), ('stg_won', 'Won', 'default', 1, true, false, 100)`,
      `insert into chat_channels (id, name, slug, type) values ('chan_general', 'general', 'general', 'public')`,
      `insert into chat_channel_members (id, channel_id, user_id, role) values ('cmb_ann', 'chan_general', 'user_approver', 'member')`,
      `insert into projects (id, name, created_at, updated_at) values ('prj_launch', 'Launch', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z')`,
      workflowRow('wf_records', [
        { id: 's1', type: 'create_customer', config: { name: ' Acme ', email: 'billing@acme.test', phone: '+31 20 1' } },
        {
          id: 's2',
          type: 'create_contact',
          config: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', companyId: '{{steps.s1.customerId}}', tags: 'vip, beta' },
        },
        { id: 's3', type: 'update_contact', config: { contactId: '{{steps.s2.contactId}}', title: 'CTO' } },
        { id: 's4', type: 'create_lead', config: { email: 'lead@example.test', firstName: 'Lee', companyName: 'Leads Ltd' } },
        {
          id: 's5',
          type: 'create_deal',
          config: { name: 'Acme renewal', customerId: '{{steps.s1.customerId}}', amount: 5000, currency: 'EUR', stageId: 'stg_open' },
        },
        { id: 's6', type: 'move_deal_stage', config: { dealId: '{{steps.s5.dealId}}', stageId: 'stg_won' } },
        { id: 's7', type: 'log_activity', config: { type: 'call', subject: 'Kickoff', customerId: '{{steps.s1.customerId}}' } },
        { id: 's8', type: 'post_chat_message', config: { channelId: 'chan_general', message: 'Deal won, <@user_approver>!' } },
        {
          id: 's9',
          type: 'create_task',
          config: { projectId: 'prj_launch', title: 'Onboard Acme', priority: 'high', assigneeIds: 'user_approver', dueDate: '2026-12-01T10:00:00.000Z' },
        },
        { id: 's10', type: 'create_customer', config: { name: 'Acme again', email: 'BILLING@acme.test' } },
      ]),
    ],
    params: { ...RUN, workflowId: 'wf_records', triggerType: 'manual', triggerData: { workflowName: 'Deal desk' } },
    inspect: [
      'select name, email, phone, status, source, owner_id from companies order by name',
      'select first_name, last_name, email, title, direct_phone, owner_id, source, tags from people order by email',
      'select first_name, last_name, email, company_name, owner_id, status from crm_leads',
      `select name, customer_id, stage_id, stage, status, probability, amount::text as amount, currency, owner_id,
         (actual_close_date is not null) as closed from crm_opportunities`,
      'select type, subject, customer_id, assigned_to_id from crm_activities',
      'select channel_id, author_id, author_name, author_type, content, mentions, mentions_everyone, metadata from chat_messages',
      'select message_count, last_message_preview from chat_channels',
      'select user_id, unread_mention_count from chat_channel_members',
      'select title, priority, status, project_id, reporter_id, assignee_id, number from tasks',
    ],
  },
  {
    name: "WeldSuite steps the owner may not run, input the step refuses, a deal that isn't there",
    instanceId: 'inst_records_refused',
    seed: [
      MEMBERS,
      `insert into workspace_members (id, user_id, email, name, role) values ('wm_3', 'user_viewer', 'vic@example.com', 'Vic', 'VIEWER')`,
      workflowRow(
        'wf_records_refused',
        [
          { id: 's1', type: 'create_lead', continueOnError: true, config: { email: 'nope@example.test' } },
          { id: 's2', type: 'create_contact', continueOnError: true, config: { email: 'not an email' } },
          { id: 's3', type: 'post_chat_message', continueOnError: true, config: { channelId: 'chan_none', message: 'hi' } },
          { id: 's4', type: 'move_deal_stage', config: { dealId: 'opp_missing', stageId: 'stg_none' } },
        ],
        { createdBy: 'user_viewer', settings: { notifyOnError: false } },
      ),
    ],
    params: { ...RUN, workflowId: 'wf_records_refused', triggerType: 'manual' },
  },
  {
    name: 'a WeldSuite step in a workflow without an owner',
    instanceId: 'inst_records_ownerless',
    seed: [
      MEMBERS,
      workflowRow('wf_records_ownerless', [{ id: 's1', type: 'create_task', config: { projectId: 'prj_x', title: 'T' } }], {
        createdBy: null,
        settings: { notifyOnError: false },
      }),
    ],
    params: { workspaceId: 'org_test', userId: 'system', workflowId: 'wf_records_ownerless', triggerType: 'schedule' },
  },
];

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** What the run's `step` did, as the Rust test records it. */
interface StepLog {
  kind: 'do' | 'sleep' | 'wait';
  name: string;
  ms?: number;
  type?: string;
}

/** Steps only one backend takes (the usage meter; Rust's run start time). */
const BACKEND_ONLY = new Set(['meter-run', 'run-started-at']);

async function runCase(db: Database, c: Case): Promise<Json> {
  for (const stmt of [...CLEAR, ...c.seed]) await db.execute(sql.raw(stmt));

  const publishes: Array<{ channel: string; payload: unknown }> = [];
  const chained: unknown[] = [];
  const calls: unknown[] = [];
  const log: StepLog[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url, body });
      const stub = c.http?.[url];
      if (!stub) return new Response('not stubbed', { status: 599 });
      return new Response(JSON.stringify(stub.body), {
        status: stub.status,
        headers: stub.headers ?? { 'content-type': 'application/json' },
      });
    }),
  );

  // connect-api's internal action routes, as its `ConnectInternal`
  // entrypoint serves them over the `CONNECT_INTERNAL` binding, with an
  // `ENTITY_EVENTS` queue that keeps what they publish.
  const events: unknown[] = [];
  const connectEnv = {
    INTERNAL_API_SECRET: 'fixture-secret',
    ENTITY_EVENTS: {
      send: async (message: unknown) => {
        events.push(message);
      },
      sendBatch: async (messages: Array<{ body: unknown }>) => {
        for (const message of messages) events.push(message.body);
      },
    },
  };
  // The entrypoint trusts the binding; here the routes see the bearer instead.
  const connectApp = (await connectInternalRoutes()) as {
    request(path: string, init: RequestInit, env: unknown, ctx: unknown): Promise<Response>;
  };

  const env = {
    CONNECT_INTERNAL: {
      fetch: async (url: string, init: RequestInit) => {
        const pending: Array<Promise<unknown>> = [];
        const executionCtx = {
          waitUntil: (promise: Promise<unknown>) => pending.push(promise),
          passThroughOnException: () => {},
          props: {},
        };
        const response = await connectApp.request(
          new URL(url).pathname.replace('/api/internal/workflow-actions', ''),
          { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: 'Bearer fixture-secret' } },
          { ...connectEnv, REALTIME: env.REALTIME },
          executionCtx,
        );
        await Promise.allSettled(pending);
        return response;
      },
    },
    REALTIME: {
      fetch: async (url: string, init: RequestInit) => {
        const pathname = new URL(url).pathname;
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        const channel = pathname === '/publish/workspace'
          ? `workspace:${String(payload.workspaceId)}`
          : pathname.replace(/^\/publish\//, '').replace('/', ':');
        publishes.push({ channel, payload });
        return new Response('{}');
      },
    },
    EXECUTE_WORKFLOW: {
      create: async (init: { id?: string; params: Record<string, unknown> }) => {
        chained.push(init);
        return { id: init.id ?? 'inst_new' };
      },
    },
  };

  const step = {
    async do(name: string, a: unknown, b?: unknown) {
      const fn = (typeof a === 'function' ? a : b) as () => Promise<unknown>;
      log.push({ kind: 'do', name });
      return fn();
    },
    async sleep(name: string, ms: number) {
      log.push({ kind: 'sleep', name, ms });
    },
    async waitForEvent(name: string, opts: { type: string }) {
      log.push({ kind: 'wait', name, type: opts.type });
      const event = c.events?.[name];
      if (event === undefined || event === 'timeout') throw new Error('waitForEvent timed out');
      return event;
    },
  };

  const workflow = new ExecuteWorkflowWorkflow({} as never, env as never);
  let outcome: Record<string, unknown>;
  try {
    const result = (await workflow.run(
      { payload: c.params, instanceId: c.instanceId, timestamp: new Date() } as never,
      step as never,
    )) as Record<string, unknown>;
    outcome = result.skipped
      ? { skipped: result.reason }
      : result.cancelled
        ? { cancelled: true }
        : { succeeded: result.success };
  } finally {
    vi.unstubAllGlobals();
  }

  const rows = async (query: string) => ((await db.execute(sql.raw(query))) as unknown as { rows: unknown[] }).rows;
  return normalise({
    outcome,
    executions: await rows(
      `select id, workflow_id, workflow_name, workflow_version, status, triggered_by, trigger_type, trigger_id,
         trigger_data, total_steps, current_step_index, output, error, execution_context, cf_workflow_instance_id,
         (started_at is not null) as started, (completed_at is not null) as completed, (duration is not null) as timed
       from workflow_executions order by workflow_id, status`,
    ),
    steps: await rows(
      `select step_id, step_name, step_type, step_index, status, output, error, retry_count,
         (select jsonb_agg(l -> 'message' order by n) from jsonb_array_elements(logs) with ordinality as x(l, n)) as logs,
         (completed_at is not null) as completed
       from workflow_execution_steps order by step_index`,
    ),
    errorLogs: await rows(
      `select workflow_id, execution_id, step_id, step_name, step_type, error_message, error_type, severity, input
       from workflow_error_logs order by step_id, error_message`,
    ),
    workflows: await rows(
      `select id, execution_count, success_count, failure_count, (last_executed_at is not null) as ran,
         (average_execution_time is not null) as averaged
       from workflows order by id`,
    ),
    notifications: await rows(
      `select user_id, title, body, category, notification_type, entity_type, entity_id, action_url, icon, severity, data
       from notifications order by user_id, title`,
    ),
    publishes,
    chained,
    calls,
    log: log.filter((entry) => !BACKEND_ONLY.has(entry.name)),
    // The entity events the WeldSuite steps published, without their random id.
    events: events.map((message) => {
      const { id: _id, ...rest } = message as Record<string, unknown>;
      return rest;
    }),
    inspected: await Promise.all((c.inspect ?? []).map((query) => rows(query))),
  });
}

/** connect-api's internal action routes (another worker's code: loaded by path, outside this package's types). */
async function connectInternalRoutes(): Promise<unknown> {
  const modulePath = path.resolve(
    import.meta.dirname,
    '../../../connect-api/src/routes/internal-workflow-actions/index.ts',
  );
  const loaded = (await import(/* @vite-ignore */ modulePath)) as { internalWorkflowActionsRoutes: unknown };
  return loaded.internalWorkflowActionsRoutes;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let db: Database;
const written: Record<string, Json> = {};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  holder.db = db;
}, 120_000);

afterAll(() => {
  if (!WRITE) return;
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, value] of Object.entries(written)) {
    writeFileSync(path.join(OUT_DIR, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }
});

function check(name: string, value: Json) {
  written[name] = value;
  if (WRITE) return;
  const file = path.join(OUT_DIR, `${name}.json`);
  expect(existsSync(file), `${file} is missing: run pnpm rust:connect-engine-fixtures`).toBe(true);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(value);
}

describe('Rust parity fixtures', () => {
  it('whole runs', async () => {
    const cases: Json[] = [];
    for (const c of CASES) {
      cases.push({
        name: c.name,
        input: JSON.parse(
          JSON.stringify({
            seed: c.seed,
            instanceId: c.instanceId,
            params: c.params,
            events: c.events ?? {},
            http: c.http ?? {},
            inspect: c.inspect ?? [],
          }),
        ) as Json,
        output: await runCase(db, c),
      });
    }
    check('engine_runs', { clear: CLEAR, cases });
  }, 120_000);
});
