/**
 * Parity fixtures for the Rust port of the integration polls
 * (`rust/modules/integrations/src/workflow_polls.rs`), written by the worker's
 * own cron: `scheduled()` on the poll schedule with a D1 index that says one
 * workspace is due, its tenant database (pglite, the real schema) seeded with
 * SQL, and Google / Airtable answering from a deterministic stub. It records
 * the provider calls with their answers, the `EXECUTE_WORKFLOW` runs, whether
 * the workspace stays in the index, and the connections' rows.
 * `rust/modules/integrations/tests/poll_parity.rs` runs the same SQL on
 * Postgres, polls the workspace in Rust with the recorded answers and
 * compares.
 *
 *   pnpm rust:integration-fixtures                    write the fixtures
 *   pnpm --filter integration-webhook-worker test     fails when they are stale
 *
 * Times written now (`updated_at`, a refreshed token's expiry, Google's
 * `timeMin`) are placeholders.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgliteDb, pgliteClientOf } from '@weldsuite/worker-kit/testing/pglite';

const holder = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getTenantDbForWorkspace: async () => holder.db,
  getTenantDbForWorkspaceById: async () => holder.db,
}));

import worker from '../index';

const OUT = path.resolve(import.meta.dirname, '../../../../../rust/modules/integrations/tests/fixtures/poll_jobs.json');
const WRITE = process.env.WRITE_RUST_FIXTURES === '1';
const ORG = 'org_poll';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const SEEDED = /^2026-10-0\d/;

function normalise(value: unknown): Json {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => normalise(item));
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(value).sort()) out[k] = normalise((value as Record<string, unknown>)[k]);
    return out;
  }
  if (typeof value === 'string' && ISO.test(value) && !SEEDED.test(value)) return '<ts>';
  return value as Json;
}

function normaliseUrl(url: string): string {
  return url.replace(/timeMin=[^&]*/, 'timeMin=<ts>');
}

const TABLES = ['workflows', 'workflow_trigger_index', 'workflow_integrations'] as const;
const T0 = "'2026-10-01 09:00:00'";
const sql = (value: unknown) => (value === null || value === undefined ? 'null' : `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`);

function workflow(id: string, triggers: unknown[], status = 'active') {
  return `insert into workflows (id, name, status, triggers, created_at, updated_at)
    values ('${id}', 'Workflow ${id}', '${status}', ${sql(triggers)}, ${T0}, ${T0})`;
}

function index(id: string, workflowId: string, provider: string, event: string) {
  return `insert into workflow_trigger_index (id, workflow_id, trigger_id, category, provider, integration_event, created_at, updated_at)
    values ('${id}', '${workflowId}', 'trg_${id}', 'integration_event', '${provider}', '${event}', ${T0}, ${T0})`;
}

function integration(id: string, type: string, opts: { tokens?: unknown; settings?: unknown; credentials?: unknown; status?: string } = {}) {
  return `insert into workflow_integrations (id, name, type, status, oauth_tokens, settings, credentials, created_at, updated_at)
    values ('${id}', '${type}', '${type}', '${opts.status ?? 'connected'}', ${sql(opts.tokens === undefined ? { accessToken: `tok-${id}` } : opts.tokens)},
      ${sql(opts.settings)}, ${sql(opts.credentials)}, ${T0}, ${T0})`;
}

const trigger = (provider: string, event: string, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id: `t_${provider}`,
  type: 'integration_event',
  provider,
  event,
  config,
  ...extra,
});

interface Scenario {
  name: string;
  env?: Record<string, string>;
  seed: string[];
  answers: Array<{ method: string; url: string; status?: number; response: unknown }>;
}

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';

const SCENARIOS: Scenario[] = [
  {
    name: 'sheets: new rows past the cursor, and a first look that only sets one',
    seed: [
      workflow('wf_sheets', [
        trigger('google_sheets', 'google_sheets.new_row', { spreadsheetId: 'sheet1' }),
        trigger('google_sheets', 'google_sheets.new_row', { spreadsheetId: 'sheet2', sheetName: 'Leads 2026' }),
      ]),
      index('wti_sheets', 'wf_sheets', 'google_sheets', 'google_sheets.new_row'),
      integration('wfi_sheets', 'google_sheets', { settings: { sheetsCursors: { 'sheet1!Sheet1': 1 }, other: true } }),
    ],
    answers: [
      { method: 'GET', url: `${SHEETS}/sheet1/values/Sheet1`, response: { values: [['h1', 'h2'], ['a', 1], ['b', 2]] } },
      { method: 'GET', url: `${SHEETS}/sheet2/values/Leads%202026`, response: { values: [['x']] } },
    ],
  },
  {
    name: 'gmail: messages newer than the last one seen; a message that fails is skipped',
    seed: [
      workflow('wf_gmail', [trigger('gmail', 'gmail.new_email', {}, { filters: [{ field: 'query', value: 'from:boss' }] })]),
      index('wti_gmail', 'wf_gmail', 'gmail', 'gmail.new_email'),
      integration('wfi_gmail', 'gmail', { settings: { gmailLastTs: '1790000000000' } }),
    ],
    answers: [
      { method: 'GET', url: `${GMAIL}?maxResults=10&labelIds=INBOX&q=from%3Aboss`, response: { messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] } },
      {
        method: 'GET',
        url: `${GMAIL}/m1?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        response: { id: 'm1', threadId: 't1', internalDate: '1790000500000', snippet: 'Hi', payload: { headers: [{ name: 'From', value: 'boss@acme.test' }, { name: 'Subject', value: 'Q4' }] } },
      },
      { method: 'GET', url: `${GMAIL}/m2?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, response: { id: 'm2', threadId: 't2', internalDate: '1780000000000' } },
      { method: 'GET', url: `${GMAIL}/m3?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, status: 404, response: { error: 'gone' } },
    ],
  },
  {
    name: 'calendar and airtable: items created since the cursor, the token refreshed first',
    env: { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' },
    seed: [
      workflow('wf_cal', [
        trigger('google_calendar', 'google_calendar.new_event', { calendarId: 'team@acme.test' }),
        trigger('airtable', 'airtable.new_record', { baseId: 'app1', tableId: 'Deals Table' }),
        trigger('airtable', 'airtable.new_record', { baseId: 'app1' }),
      ]),
      index('wti_cal', 'wf_cal', 'google_calendar', 'google_calendar.new_event'),
      index('wti_air', 'wf_cal', 'airtable', 'airtable.new_record'),
      integration('wfi_cal', 'google_calendar', {
        tokens: { accessToken: 'stale', refreshToken: 'refresh-1', expiresAt: '2026-01-01T00:00:00.000Z' },
        settings: { calendarLastCreated: '2026-10-02T00:00:00.000Z' },
      }),
      integration('wfi_air', 'airtable', {
        tokens: null,
        credentials: { token: 'pat-air' },
        settings: { airtableCursors: { 'app1:Deals Table': '2026-10-03T00:00:00.000Z' } },
      }),
    ],
    answers: [
      { method: 'POST', url: 'https://oauth2.googleapis.com/token', response: { access_token: 'fresh', expires_in: 3600 } },
      {
        method: 'GET',
        url: 'https://www.googleapis.com/calendar/v3/calendars/team%40acme.test/events?timeMin=<ts>&singleEvents=true&orderBy=startTime&maxResults=10',
        response: {
          items: [
            { id: 'e1', summary: 'Kickoff', start: { dateTime: '2026-11-10T10:00:00Z' }, end: { dateTime: '2026-11-10T11:00:00Z' }, htmlLink: 'https://cal/e1', created: '2026-10-04T08:00:00.000Z' },
            { id: 'e2', summary: 'Old', created: '2026-10-01T08:00:00.000Z' },
            { id: 'e3' },
          ],
        },
      },
      {
        method: 'GET',
        url: 'https://api.airtable.com/v0/app1/Deals%20Table?pageSize=50',
        response: {
          records: [
            { id: 'rec2', fields: { Name: 'Second' }, createdTime: '2026-10-05T10:00:00.000Z' },
            { id: 'rec0', fields: { Name: 'Old' }, createdTime: '2026-10-01T10:00:00.000Z' },
            { id: 'rec1', fields: { Name: 'First' }, createdTime: '2026-10-04T10:00:00.000Z' },
          ],
        },
      },
    ],
  },
  {
    name: 'a workspace whose poll triggers have no connection, or none at all',
    seed: [
      workflow('wf_none', [trigger('gmail', 'gmail.new_email')]),
      workflow('wf_paused', [trigger('google_sheets', 'google_sheets.new_row', { spreadsheetId: 's' })], 'paused'),
      integration('wfi_off', 'gmail', { status: 'disconnected' }),
    ],
    answers: [],
  },
  {
    name: 'a workspace without poll triggers is dropped',
    seed: [workflow('wf_plain', [{ id: 't1', type: 'manual' }])],
    answers: [],
  },
];

interface Exchange {
  method: string;
  url: string;
  status: number;
  response: unknown;
  responseText: string;
}

let client: NonNullable<ReturnType<typeof pgliteClientOf>>;

beforeAll(async () => {
  const handle = await createPgliteDb();
  holder.db = handle.db;
  client = pgliteClientOf(handle.db)!;
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

async function dump(): Promise<Record<string, Json[]>> {
  const out: Record<string, Json[]> = {};
  for (const table of TABLES) {
    const { rows } = (await client.query(`select to_jsonb(t) as row from ${table} t`)) as { rows: Array<{ row: unknown }> };
    out[table] = rows.map((r) => normalise(r.row)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return out;
}

/** The D1 index: one due workspace for the polls, nothing else. */
function d1(marks: Array<{ nextDueAt: unknown }>) {
  return {
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => ({
        all: async () => {
          if (query.includes('SELECT 1 AS ok')) return { results: [{ ok: 1 }] };
          if (query.includes('FROM tenant_work_index') && args[0] === 'workflow_poll') {
            return { results: [{ id: `workflow_poll:ws_poll`, workspace_id: 'ws_poll', clerk_org_id: ORG, kind: 'workflow_poll', enabled: 1, next_due_at: 0 }] };
          }
          return { results: [] };
        },
        first: async () => null,
        run: async () => {
          if (query.includes('UPDATE tenant_work_index') && args.includes('workflow_poll')) {
            marks.push({ nextDueAt: query.includes('SET enabled = 0') ? null : args[0] });
          }
          return {};
        },
      }),
    }),
  };
}

async function run(scenario: Scenario) {
  for (const table of TABLES) await client.exec(`delete from ${table}`);
  for (const statement of scenario.seed) await client.exec(statement);
  const exchanges: Exchange[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = normaliseUrl(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const answer = scenario.answers.find((a) => a.method === method && a.url === url);
    const status = answer ? (answer.status ?? 200) : 599;
    const response = answer ? answer.response : { message: 'no recorded answer' };
    const responseText = JSON.stringify(response);
    exchanges.push({ method, url, status, response, responseText });
    return new Response(responseText, { status, headers: { 'Content-Type': 'application/json' } });
  });
  const runs: unknown[] = [];
  const marks: Array<{ nextDueAt: unknown }> = [];
  const env = {
    ENVIRONMENT: 'test',
    CONNECTOR_SYNC_INDEX: d1(marks),
    EXECUTE_WORKFLOW: { create: async (options: { params: unknown }) => void runs.push(options.params) },
    ...scenario.env,
  };
  const pending: Promise<unknown>[] = [];
  worker.scheduled!({ cron: '*/10 * * * *', scheduledTime: Date.now(), noRetry: () => {} } as never, env as never, {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as never);
  await Promise.allSettled(pending);
  vi.unstubAllGlobals();
  return {
    name: scenario.name,
    env: scenario.env ?? {},
    seed: scenario.seed,
    exchanges,
    runs: normalise(runs),
    kept: marks.map((m) => m.nextDueAt !== null),
    rows: await dump(),
  };
}

describe('Rust parity fixtures', () => {
  it('integration polls', async () => {
    const outcomes = [];
    for (const scenario of SCENARIOS) outcomes.push(await run(scenario));
    const text = `${JSON.stringify(outcomes, null, 2)}\n`;
    if (WRITE) {
      mkdirSync(path.dirname(OUT), { recursive: true });
      writeFileSync(OUT, text);
      return;
    }
    expect(existsSync(OUT), `${OUT} is missing: run pnpm rust:integration-fixtures`).toBe(true);
    expect(JSON.parse(readFileSync(OUT, 'utf8')), 'stale fixtures: run pnpm rust:integration-fixtures').toEqual(JSON.parse(text));
  }, 120_000);
});
