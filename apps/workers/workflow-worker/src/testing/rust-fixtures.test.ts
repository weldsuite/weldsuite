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
/** A Message-ID a send made: `<hex32@domain>`. */
const MESSAGE_ID = /^<[0-9a-f]{32}@[^>]+>$/;
const GENERATED = /\b([a-z]+)_[0-9A-Za-z]{24}\b/g;
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
    if (MESSAGE_ID.test(value)) return '<message-id>';
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
  'delete from workflow_integrations',
  'delete from helpdesk_conversation_messages',
  'delete from helpdesk_conversations',
  'delete from helpdesk_agents',
  'delete from mail_folders',
  'delete from mail_correspondents',
  'truncate mail_accounts cascade',
];

const MEMBERS = `insert into workspace_members (id, user_id, email, name, role)
  values ('wm_1', 'user_owner', 'owner@example.com', 'Owner', 'OWNER'),
         ('wm_2', 'user_approver', 'ann@example.com', 'Ann', 'MEMBER')`;

/** The connected integrations the provider steps use (plain tokens: no keyring in the fixtures). */
const INTEGRATIONS = `insert into workflow_integrations (id, name, type, status, credentials, oauth_tokens)
  values ('win_slack', 'Slack', 'slack', 'connected', null, '{"accessToken":"xoxb-1"}'::jsonb),
         ('win_sheets', 'Sheets', 'google_sheets', 'connected', null, '{"accessToken":"ya29.s"}'::jsonb),
         ('win_gmail', 'Gmail', 'gmail', 'connected', null, '{"accessToken":"ya29.g"}'::jsonb),
         ('win_cal', 'Calendar', 'google_calendar', 'connected', null, '{"accessToken":"ya29.c"}'::jsonb),
         ('win_teams', 'Teams', 'teams', 'connected', '{"webhookUrl":"https://teams.example.com/hook"}'::jsonb, null),
         ('win_twilio', 'Twilio', 'twilio', 'connected', '{"accountSid":"AC1","authToken":"tok","fromNumber":"+15550001"}'::jsonb, null),
         ('win_notion', 'Notion', 'notion', 'connected', '{"token":"secret_n"}'::jsonb, null),
         ('win_airtable', 'Airtable', 'airtable', 'connected', '{"token":"pat_a"}'::jsonb, null),
         ('win_asana', 'Asana', 'asana', 'connected', '{"token":"asana_t"}'::jsonb, null)`;

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
  {
    name: 'third-party steps through the connected integrations, and Telnyx',
    instanceId: 'inst_providers',
    seed: [
      MEMBERS,
      INTEGRATIONS,
      workflowRow('wf_providers', [
        { id: 's1', type: 'slack.post_message', config: { channel: 'C1', text: 'Hi {{trigger.name}}' } },
        { id: 's2', type: 'slack_message', config: { channel: '#general', text: 'Legacy' } },
        {
          id: 's3',
          type: 'google_sheets.append_row',
          config: { spreadsheetId: 'sheet 1', sheetName: 'Leads', columnMapping: { A: 'Ada', C: '{{trigger.name}}' } },
        },
        {
          id: 's4',
          type: 'google_sheets.update_row',
          config: { spreadsheetId: 'sheet1', lookupColumn: 'B', lookupValue: 'x2', columnMapping: '{"C":"done"}' },
        },
        {
          id: 's5',
          type: 'gmail.send_email',
          config: { to: 'a@example.com; Bo <b@example.com>', subject: 'Hello', body: 'Line 1\nLine <2>', isHtml: false },
        },
        {
          id: 's6',
          type: 'google_calendar.create_event',
          config: {
            summary: 'Kickoff',
            startDateTime: '2026-12-01T10:00:00Z',
            endDateTime: '2026-12-01T11:00:00Z',
            attendees: 'x@example.com, y@example.com',
            description: 'Agenda',
          },
        },
        { id: 's7', type: 'teams.post_message', config: { text: 'Ping', title: 'Heads up' } },
        { id: 's8', type: 'twilio.send_sms', config: { to: '+15550002', body: 'Yo' } },
        {
          id: 's9',
          type: 'notion.create_page',
          config: { databaseId: 'db1', title: 'Page', properties: '{"Status":{"select":{"name":"Open"}}}' },
        },
        { id: 's10', type: 'airtable.create_record', config: { baseId: 'app1', tableId: 'Leads Table', fields: { Name: 'Ada' } } },
        { id: 's11', type: 'airtable.update_record', config: { baseId: 'app1', tableId: 'tbl1', recordId: 'rec1', fields: '{"Done":true}' } },
        { id: 's12', type: 'asana.create_task', config: { name: 'Follow up', projectId: 'p1', dueOn: '2026-12-01' } },
        { id: 's13', type: 'asana.update_task', config: { taskId: 'as1', completed: true, name: 'Done' } },
        { id: 's14', type: 'notion.update_page', config: { pageId: 'pg1', properties: { Done: { checkbox: true } } } },
        { id: 's15', type: 'send_sms', config: { to: '+15550003', message: 'SMS {{trigger.name}}', from: '+15550009' } },
        { id: 's16', type: 'github.create_issue', continueOnError: true, config: { repo: 'not-a-repo', title: 'x' } },
      ]),
    ],
    params: { ...RUN, workflowId: 'wf_providers', triggerType: 'manual', triggerData: { name: 'Ann' } },
    http: {
      'https://slack.com/api/chat.postMessage': { status: 200, body: { ok: true, channel: 'C1', ts: '1700.01' } },
      'https://slack.com/api/chat.getPermalink?channel=C1&message_ts=1700.01': {
        status: 200,
        body: { ok: true, permalink: 'https://acme.slack.com/p1' },
      },
      'https://sheets.googleapis.com/v4/spreadsheets/sheet%201/values/Leads!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS':
        { status: 200, body: { updates: { updatedRange: 'Leads!A2:C2', updatedRows: 1 } } },
      'https://sheets.googleapis.com/v4/spreadsheets/sheet1/values/Sheet1!B%3AB': {
        status: 200,
        body: { values: [['x1'], ['x2']] },
      },
      'https://sheets.googleapis.com/v4/spreadsheets/sheet1/values:batchUpdate': { status: 200, body: { totalUpdatedCells: 1 } },
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send': { status: 200, body: { id: 'g1', threadId: 't1' } },
      'https://www.googleapis.com/calendar/v3/calendars/primary/events': {
        status: 200,
        body: { id: 'ev1', htmlLink: 'https://calendar.example.com/ev1' },
      },
      'https://teams.example.com/hook': { status: 200, body: {} },
      'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json': { status: 201, body: { sid: 'SM1' } },
      'https://api.notion.com/v1/pages': { status: 200, body: { id: 'pg1', url: 'https://notion.so/pg1' } },
      'https://api.notion.com/v1/pages/pg1': { status: 200, body: { id: 'pg1' } },
      'https://api.airtable.com/v0/app1/Leads%20Table': { status: 200, body: { id: 'rec1' } },
      'https://api.airtable.com/v0/app1/tbl1/rec1': { status: 200, body: { id: 'rec1' } },
      'https://app.asana.com/api/1.0/tasks': { status: 201, body: { data: { gid: 'as1' } } },
      'https://app.asana.com/api/1.0/tasks/as1': { status: 200, body: { data: { gid: 'as1' } } },
      'https://api.telnyx.com/v2/messages': { status: 200, body: { data: { id: 'tx1' } } },
    },
  },
  {
    name: 'provider refusals: Slack, Google, Notion, Airtable, Twilio, a missing integration',
    instanceId: 'inst_providers_refused',
    seed: [
      MEMBERS,
      INTEGRATIONS,
      workflowRow(
        'wf_providers_refused',
        [
          { id: 's1', type: 'slack.post_message', continueOnError: true, config: { channel: 'C9', text: 'Hi' } },
          {
            id: 's2',
            type: 'google_sheets.append_row',
            continueOnError: true,
            config: { spreadsheetId: 'locked', columnMapping: { A: 1 } },
          },
          {
            id: 's3',
            type: 'notion.update_page',
            continueOnError: true,
            retryPolicy: { maxAttempts: 1 },
            config: { pageId: 'pg9', properties: {} },
          },
          {
            id: 's4',
            type: 'airtable.create_record',
            continueOnError: true,
            retryPolicy: { maxAttempts: 1 },
            config: { baseId: 'app9', tableId: 't9', fields: {} },
          },
          {
            id: 's5',
            type: 'twilio.send_sms',
            continueOnError: true,
            retryPolicy: { maxAttempts: 1 },
            config: { to: '+1', body: 'x' },
          },
          {
            id: 's6',
            type: 'google_calendar.create_event',
            continueOnError: true,
            config: { summary: 'S', startDateTime: '2026-12-01T10:00', endDateTime: '2026-12-01T11:00' },
          },
          { id: 's7', type: 'google_sheets.update_row', continueOnError: true, config: { spreadsheetId: 's', columnMapping: { '1': 'x' } } },
          { id: 's8', type: 'gmail.send_email', continueOnError: true, config: { to: 'nope', subject: 's', body: 'b' } },
          {
            id: 's9',
            type: 'asana.create_task',
            retryPolicy: { maxAttempts: 1 },
            config: { name: 'T', workspaceId: 'w1', integrationId: 'win_gone' },
          },
        ],
        { settings: { notifyOnError: false } },
      ),
    ],
    params: { ...RUN, workflowId: 'wf_providers_refused', triggerType: 'manual' },
    http: {
      'https://slack.com/api/chat.postMessage': { status: 200, body: { ok: false, error: 'not_in_channel' } },
      'https://sheets.googleapis.com/v4/spreadsheets/locked/values/Sheet1!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS':
        {
          status: 403,
          body: { error: { code: 403, message: 'The caller does not have permission', errors: [{ reason: 'forbidden' }] } },
        },
      'https://api.notion.com/v1/pages/pg9': { status: 400, body: { message: 'body failed validation' } },
      'https://api.airtable.com/v0/app9/t9': { status: 422, body: { error: { type: 'INVALID_REQUEST' } } },
      'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json': {
        status: 400,
        body: { error_message: "The 'To' number +1 is not valid" },
      },
    },
  },
  {
    name: 'send_email from the default mailbox through the outbound guard; a step with no mailbox',
    instanceId: 'inst_email',
    seed: [
      MEMBERS,
      `insert into mail_accounts (id, name, email, display_name, status, is_default)
        values ('mac_1', 'Sales', 'sales@acme.test', 'Acme Sales', 'active', true),
               ('mac_2', 'Support', 'support@acme.test', null, 'active', false)`,
      workflowRow('wf_email', [
        {
          id: 's1',
          type: 'send_email',
          config: { to: ['ann@example.com', 'Bo <bo@example.com>'], cc: 'cc@example.com', subject: ' Welcome ', body: '<p>Hi <b>Ann</b></p>' },
        },
        { id: 's2', type: 'send_email', config: { to: 'cy@example.com', subject: 'Plain', body: 'a\nb', isHtml: false, from: 'support@acme.test' } },
        { id: 's3', type: 'send_email', continueOnError: true, config: { to: 'bad address', subject: 'x' } },
        { id: 's4', type: 'send_email', continueOnError: true, config: { to: 'd@example.com', subject: '  ' } },
        { id: 's5', type: 'send_email', config: { to: 'e@example.com', subject: 'Who', from: 'nobody@acme.test' } },
      ]),
    ],
    params: { ...RUN, workflowId: 'wf_email', triggerType: 'manual' },
  },
  {
    name: 'legacy helpdesk conversation steps (assign, tags, status, priority, reply, note)',
    instanceId: 'inst_helpdesk',
    seed: [
      MEMBERS,
      `insert into helpdesk_conversations (id, conversation_number, customer_name, subject, tags)
        values ('hcv_1', 'C-1', 'Cy', 'Help', '["old"]'::jsonb)`,
      `insert into helpdesk_agents (id, user_id, name, email, status, tickets_assigned, current_active_tickets)
        values ('hag_1', 'user_approver', 'Ann', 'ann@example.com', 'active', 3, 1),
               ('hag_2', 'user_owner', 'Owner', 'owner@example.com', 'active', 1, 2)`,
      workflowRow('wf_helpdesk', [
        { id: 's1', type: 'assign_conversation', config: { strategy: 'round_robin' } },
        { id: 's2', type: 'tag_conversation', config: { tags: ['vip', 'old', 'billing'] } },
        { id: 's3', type: 'tag_conversation', config: { mode: 'remove', tags: ['vip'] } },
        { id: 's4', type: 'change_conversation_status', config: { status: 'resolved' } },
        { id: 's5', type: 'change_priority', config: { priority: 'high' } },
        { id: 's6', type: 'send_reply', config: { message: 'Thanks', authorType: 'agent' } },
        { id: 's7', type: 'add_internal_note', config: { content: 'Escalated' } },
        { id: 's8', type: 'assign_conversation', config: { strategy: 'specific_agent', agentId: 'user_x', agentName: 'Xi' } },
      ]),
    ],
    params: {
      ...RUN,
      workflowId: 'wf_helpdesk',
      triggerType: 'entity_event',
      triggerData: { entityType: 'helpdesk_conversation', entityId: 'hcv_1' },
    },
    inspect: [
      'select status, priority, tags, assignee_id, assignee_name, (resolved_at is not null) as resolved from helpdesk_conversations',
      `select content, author_type, author_id, author_name, type, is_public, is_internal, status
         from helpdesk_conversation_messages order by type`,
      'select id, tickets_assigned, current_active_tickets from helpdesk_agents order by id',
    ],
  },
  {
    name: 'generic record steps: create, update, query, delete, and the mail and Drizzle refusals',
    instanceId: 'inst_records_generic',
    seed: [
      MEMBERS,
      `insert into crm_pipeline_stages (id, name, pipeline, position, probability) values ('stg_seed', 'Seed', 'default', 0, 10)`,
      `insert into mail_accounts (id, name, email, status, is_shared)
        values ('mac_shared', 'Shared', 'shared@acme.test', 'active', true),
               ('mac_private', 'Private', 'me@acme.test', 'active', false)`,
      workflowRow('wf_records_generic', [
        {
          id: 's1',
          type: 'create_record',
          config: { entity: 'pipeline-stage', data: { name: 'Qualified', pipeline: 'default', position: 2, probability: 40, extra: 'ignored' } },
        },
        {
          id: 's2',
          type: 'update_record',
          config: { entityType: 'pipeline_stage', id: '{{steps.s1.record.id}}', data: { probability: 60, isWon: false } },
        },
        { id: 's3', type: 'query_data', config: { entity: 'pipeline_stage', filters: { probability: { operator: 'gt', value: 50 } } } },
        { id: 's4', type: 'delete_record', config: { entity: 'pipeline_stage', id: '{{steps.s1.record.id}}' } },
        { id: 's5', type: 'query_data', config: { entity: 'pipeline_stage', where: { pipeline: 'default' }, limit: 10 } },
        {
          id: 's6',
          type: 'create_record',
          continueOnError: true,
          retryPolicy: { maxAttempts: 1 },
          config: { entity: 'mail_account', data: { name: 'Ops', email: 'ops@acme.test', isShared: false } },
        },
        {
          id: 's7',
          type: 'create_record',
          continueOnError: true,
          retryPolicy: { maxAttempts: 1 },
          config: { entity: 'mail_account', data: { name: 'Ops', email: 'ops@acme.test', apiKey: 'k', passwordHash: 'h' } },
        },
        { id: 's8', type: 'create_record', config: { entity: 'mail_account', fields: { name: 'Ops', email: 'ops@acme.test' } } },
        {
          id: 's9',
          type: 'create_record',
          continueOnError: true,
          retryPolicy: { maxAttempts: 1 },
          config: { entity: 'mail_folder', data: { name: 'Inbox', accountId: 'mac_private' } },
        },
        { id: 's10', type: 'query_data', config: { entity: 'mail_account', filters: { email: { operator: 'contains', value: 'acme' } } } },
        {
          id: 's11',
          type: 'update_record',
          continueOnError: true,
          retryPolicy: { maxAttempts: 1 },
          config: { entity: 'mail_account', id: 'mac_private', data: { name: 'Mine now' } },
        },
        {
          id: 's12',
          type: 'create_record',
          continueOnError: true,
          retryPolicy: { maxAttempts: 1 },
          config: { entity: 'task', data: { title: 'T', dueDate: '2026-12-01' } },
        },
        { id: 's13', type: 'create_record', continueOnError: true, retryPolicy: { maxAttempts: 1 }, config: { entity: 'spaceship' } },
        { id: 's14', type: 'delete_record', config: { entity: 'mail_account', id: 'mac_private', hardDelete: true } },
        { id: 's15', type: 'delete_record', config: { entity: 'mail_account', id: 'mac_shared', hardDelete: true } },
        { id: 's16', type: 'query_data', config: { entity: 'mail-account', limit: 1, offset: 1 } },
      ]),
    ],
    params: { ...RUN, workflowId: 'wf_records_generic', triggerType: 'manual' },
    inspect: [
      'select name, probability, is_won, (deleted_at is not null) as deleted from crm_pipeline_stages order by name',
      'select id, name, email, is_shared from mail_accounts order by email',
    ],
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
      // JSON bodies parsed; a form body (Twilio, a token refresh) as its text.
      let body: unknown = null;
      if (init?.body) {
        try {
          body = JSON.parse(String(init.body));
        } catch {
          body = String(init.body);
        }
      }
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

  // app-api's `/api/internal/send-email` (send_email), over `APP_API_INTERNAL`,
  // with a `SEND_EMAIL` binding that keeps each envelope.
  const mail: Array<{ from: string; to: string }> = [];
  const appApp = (await appApiInternalRoutes()) as typeof connectApp;
  const appEnv = {
    INTERNAL_API_SECRET: 'fixture-secret',
    SEND_EMAIL: {
      send: async (message: { from: string; to: string }) => {
        mail.push({ from: bareAddress(message.from), to: bareAddress(message.to) });
      },
    },
  };

  const env = {
    TELNYX_API_KEY: 'telnyx-key',
    APP_API_INTERNAL: {
      fetch: async (url: string, init: RequestInit) => {
        const pending: Array<Promise<unknown>> = [];
        const executionCtx = {
          waitUntil: (promise: Promise<unknown>) => pending.push(promise),
          passThroughOnException: () => {},
          props: {},
        };
        const response = await appApp.request(
          new URL(url).pathname.replace('/api/internal', ''),
          { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: 'Bearer fixture-secret' } },
          appEnv,
          executionCtx,
        );
        await Promise.allSettled(pending);
        return response;
      },
    },
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
    // Customer mail sent (send_email): one envelope per recipient.
    mail,
  });
}

/** `Name <a@b>` → `a@b`, lowercased. */
function bareAddress(value: string): string {
  return (/<([^>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
}

/** app-api's internal routes (another worker's code, loaded by path). */
async function appApiInternalRoutes(): Promise<unknown> {
  const modulePath = path.resolve(import.meta.dirname, '../../../app-api/src/routes/internal/index.ts');
  const loaded = (await import(/* @vite-ignore */ modulePath)) as { internalRoutes: unknown };
  return loaded.internalRoutes;
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
