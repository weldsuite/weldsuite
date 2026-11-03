/**
 * Parity fixtures for the Rust port of the CRM sync Workflow
 * (`rust/modules/integrations/src/crm`, the `integrations.crm-sync` job),
 * written by the TypeScript `CrmSyncWorkflow` itself.
 *
 * Each scenario seeds the tenant database (pglite, the real schema) with SQL,
 * runs the Workflow's `run()` with a `step` that runs each step once, and
 * answers the providers (Attio, HubSpot, Google Calendar) from a
 * deterministic stub. It records the steps taken, the error a run ended
 * with, every provider call with its answer, and the rows left.
 * `rust/modules/integrations/tests/crm_jobs_parity.rs` runs the same SQL on
 * Postgres, runs the Rust job with the recorded answers (matched by method,
 * URL and body) and compares.
 *
 *   pnpm rust:integration-fixtures                    write the fixtures
 *   pnpm --filter integration-webhook-worker test     fails when they are stale
 *
 * Generated ids and times written now are placeholders; seeded times and the
 * providers' (2026-10-0x) stay. Google's `timeMin` (thirty days before now)
 * is a placeholder too.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgliteDb, pgliteClientOf } from '@weldsuite/worker-kit/testing/pglite';

const holder = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getTenantDbForWorkspace: async () => holder.db,
}));

import { CrmSyncWorkflow } from '../workflows/crm-sync';

const OUT = path.resolve(import.meta.dirname, '../../../../../rust/modules/integrations/tests/fixtures/crm_jobs.json');
const WRITE = process.env.WRITE_RUST_FIXTURES === '1';
const ORG = 'org_crm';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const SEEDED = /^2026-10-0\d/;
const GENERATED = /^(company|person|opp|evt|act|iem|slog|cnfl)_[0-9a-z]{14,}$/;

function normalise(value: unknown, key?: string): Json {
  if (value === undefined) return null;
  if (key === 'duration_ms' && typeof value === 'number') return '<ms>';
  if (Array.isArray(value)) return value.map((item) => normalise(item));
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(value).sort()) out[k] = normalise((value as Record<string, unknown>)[k], k);
    return out;
  }
  if (typeof value === 'string') {
    if (GENERATED.test(value)) return `<id:${value.split('_')[0]}>`;
    if (ISO.test(value) && !SEEDED.test(value)) return '<ts>';
  }
  return value as Json;
}

/** Google's `timeMin` is thirty days before now. */
function normaliseUrl(url: string): string {
  return url.replace(/timeMin=[^&]*/, 'timeMin=<ts>');
}

const TABLES = [
  'companies',
  'people',
  'crm_opportunities',
  'calendar_events',
  'integration_entity_mappings',
  'integration_field_mappings',
  'integration_sync_conflicts',
  'integration_connections',
  'sync_logs',
] as const;

const T0 = "'2026-10-01 09:00:00'";
const sql = (value: unknown) => (value === null || value === undefined ? 'null' : `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`);

function connection(
  id: string,
  provider: string,
  opts: { tokens?: unknown; syncSettings?: unknown; entityConfig?: unknown; strategy?: string; settings?: unknown; cursor?: unknown } = {},
) {
  const tokens = opts.tokens === undefined ? { accessToken: `token-${id}` } : opts.tokens;
  return `insert into integration_connections (id, provider, name, status, oauth_tokens, sync_settings, entity_config, conflict_strategy, settings, sync_cursor, connected_by, created_at, updated_at)
    values ('${id}', '${provider}', '${provider}', 'active', ${sql(tokens)}, ${sql(opts.syncSettings)}, ${sql(opts.entityConfig)},
      '${opts.strategy ?? 'last_write_wins'}', ${sql(opts.settings)}, ${sql(opts.cursor)}, 'user_1', ${T0}, ${T0})`;
}

function company(id: string, name: string, email: string | null, updated = '2026-10-01 09:00:00') {
  return `insert into companies (id, name, display_name, email, created_at, updated_at)
    values ('${id}', '${name}', '${name}', ${email ? `'${email}'` : 'null'}, ${T0}, '${updated}')`;
}

function mapping(id: string, connectionId: string, type: string, externalId: string, internalType: string, internalId: string, checksum: string | null) {
  return `insert into integration_entity_mappings (id, connection_id, external_entity_type, external_entity_id, internal_entity_type, internal_entity_id, sync_checksum, created_at, updated_at)
    values ('${id}', '${connectionId}', '${type}', '${externalId}', '${internalType}', '${internalId}', ${checksum ? `'${checksum}'` : 'null'}, ${T0}, ${T0})`;
}

function checksumOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// ── Provider data ───────────────────────────────────────────────────────────

const ACME_VALUES = {
  name: [{ value: 'Acme BV' }],
  domains: [{ domain: 'acme.test' }],
  email_addresses: [{ email_address: 'hello@acme.test' }],
  categories: [{ option: { title: 'B2B' } }],
};
const DUPE_VALUES = { name: [{ value: 'Renamed Co' }], email_addresses: [{ email_address: 'existing@co.test' }] };
const ADA_VALUES = {
  name: [{ first_name: 'Ada', last_name: 'Lovelace', full_name: 'Ada Lovelace' }],
  email_addresses: [{ email_address: 'ada@acme.test' }],
  phone_numbers: [{ original_phone_number: '', phone_number: '+3120123' }],
  job_title: [{ value: 'CTO' }],
  company: [{ target_record_id: 'rec_acme' }],
};
const SOLO_VALUES = { name: [{ first_name: 'Solo', last_name: '' }], email_addresses: [{ email_address: 'solo@home.test' }] };
const SAME_VALUES = { name: [{ first_name: 'Same', last_name: 'Again' }], company: [{ target_record_id: 'rec_acme' }] };

const HUB_COMPANY = { id: '501', properties: { name: 'Hub Co', domain: 'hub.test', phone: '+1 555', industry: 'SaaS', city: 'Utrecht' }, updatedAt: '2026-10-04T10:00:00Z', archived: false };
const HUB_CONFLICT = { id: '502', properties: { name: 'Remote name', domain: 'remote.test' }, updatedAt: '2026-10-04T10:00:00Z', archived: false };
const HUB_CONTACT = { id: '601', properties: { firstname: 'Grace', lastname: 'Hopper', email: 'grace@hub.test', lifecyclestage: 'lead', jobtitle: null }, createdAt: '2026-10-02T10:00:00Z' };
const HUB_DEAL_1 = { id: '701', properties: { dealname: 'Deal one', amount: '1000', dealstage: 'closedwon', closedate: '2026-10-05T00:00:00Z' }, updatedAt: '2026-10-05T10:00:00Z' };
const HUB_DEAL_2 = { id: '702', properties: { dealname: 'Deal two', dealstage: 'unknownstage' }, updatedAt: '2026-10-05T10:00:00Z' };

const GOOGLE_EVENTS = [
  {
    id: 'gev_timed',
    summary: 'Planning',
    description: 'Quarterly',
    start: { dateTime: '2026-10-06T10:00:00+02:00', timeZone: 'Europe/Amsterdam' },
    end: { dateTime: '2026-10-06T11:00:00+02:00' },
    attendees: [{ email: 'ada@acme.test', displayName: 'Ada', responseStatus: 'accepted', organizer: true }, { email: 'bob@acme.test' }],
    hangoutLink: 'https://meet.google.com/abc',
    updated: '2026-10-05T08:00:00.000Z',
  },
  { id: 'gev_allday', summary: '', start: { date: '2026-10-07' }, end: { date: '2026-10-08' }, recurrence: ['RRULE:FREQ=WEEKLY'], status: 'tentative' },
];

interface Scenario {
  name: string;
  payload: Record<string, unknown>;
  seed: string[];
  env?: Record<string, string>;
  /** Answers by method and URL (a `timeMin` placeholder in Google's). */
  answers: Array<{ method: string; url: string; body?: unknown; status?: number; response: unknown }>;
}

const ATTIO = 'https://api.attio.com/v2';
const HUB = 'https://api.hubapi.com/crm/v3/objects';
const HUB_PROPS = {
  contacts: 'firstname%2Clastname%2Cemail%2Cphone%2Cmobilephone%2Cjobtitle%2Ccompany%2Cwebsite%2Clifecyclestage%2Chs_lead_status%2Caddress%2Ccity%2Cstate%2Czip%2Ccountry',
  companies: 'name%2Cdomain%2Cphone%2Cindustry%2Cdescription%2Cnumberofemployees%2Cannualrevenue%2Cwebsite%2Ccity%2Cstate%2Czip%2Ccountry%2Caddress',
  deals: 'dealname%2Camount%2Cdealstage%2Cpipeline%2Cclosedate%2Chs_lastmodifieddate%2Cdescription%2Cdeal_currency_code',
};
const GOOGLE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=250&singleEvents=true&orderBy=updated';

const SCENARIOS: Scenario[] = [
  {
    name: 'attio: companies and people, deduped by email, an unchanged record skipped',
    payload: { workspaceId: ORG, connectionId: 'conn_attio', provider: 'attio', syncType: 'full' },
    seed: [
      connection('conn_attio', 'attio', { cursor: { customer: '', other: 'x' } }),
      company('company_existing', 'Existing Co', 'existing@co.test'),
      mapping('iem_same', 'conn_attio', 'contact', 'rec_same', 'person', 'person_same', checksumOf(SAME_VALUES)),
    ],
    answers: [
      {
        method: 'POST',
        url: `${ATTIO}/objects/companies/records/query`,
        body: { limit: 500, offset: 0 },
        response: {
          data: [
            { id: { record_id: 'rec_acme' }, values: ACME_VALUES, created_at: '2026-10-02T09:00:00.000000000Z' },
            { id: { record_id: 'rec_dupe' }, values: DUPE_VALUES, created_at: '2026-10-02T09:00:00Z' },
          ],
        },
      },
      {
        method: 'POST',
        url: `${ATTIO}/objects/people/records/query`,
        body: { limit: 500, offset: 0 },
        response: {
          data: [
            { id: { record_id: 'rec_ada' }, values: ADA_VALUES, created_at: '2026-10-03T09:00:00Z' },
            { id: { record_id: 'rec_solo' }, values: SOLO_VALUES, created_at: '2026-10-03T09:00:00Z' },
            { id: { record_id: 'rec_same' }, values: SAME_VALUES, created_at: '2026-10-03T09:00:00Z' },
          ],
        },
      },
    ],
  },
  {
    name: 'hubspot: field mappings, a queued conflict, a lookup, paging and a deal Drizzle refuses',
    payload: { workspaceId: ORG, connectionId: 'conn_hub', provider: 'hubspot', syncType: 'incremental' },
    seed: [
      connection('conn_hub', 'hubspot', {
        syncSettings: { syncPeople: true, syncOpportunities: true, syncCalendarEvents: false },
        entityConfig: { customer: 'bidirectional', contact: 'bidirectional', opportunity: 'inbound' },
        strategy: 'manual',
      }),
      company('company_conflict', 'Local name', null, '2026-10-03 09:00:00.250'),
      mapping('iem_conflict', 'conn_hub', 'customer', '502', 'company', 'company_conflict', 'stale'),
    ],
    answers: [
      {
        method: 'GET',
        url: `${HUB}/companies?limit=100&properties=${HUB_PROPS.companies}`,
        response: { results: [HUB_COMPANY, HUB_CONFLICT] },
      },
      {
        method: 'GET',
        url: `${HUB}/contacts?limit=100&properties=${HUB_PROPS.contacts}`,
        response: { results: [HUB_CONTACT], paging: { next: { after: 'c2' } } },
      },
      {
        method: 'GET',
        url: `${HUB}/contacts?limit=100&properties=${HUB_PROPS.contacts}&after=c2`,
        response: { results: [] },
      },
      {
        method: 'GET',
        url: `${HUB}/deals?limit=100&properties=${HUB_PROPS.deals}`,
        response: { results: [HUB_DEAL_1, HUB_DEAL_2] },
      },
    ],
  },
  {
    name: 'hubspot: last write wins keeps the newer internal record',
    payload: { workspaceId: ORG, connectionId: 'conn_lww', provider: 'hubspot', syncType: 'full', entityTypes: ['customer'] },
    seed: [
      connection('conn_lww', 'hubspot', { entityConfig: { customer: 'bidirectional' } }),
      company('company_newer', 'Local name', null, '2026-10-06 09:00:00'),
      mapping('iem_newer', 'conn_lww', 'customer', '502', 'company', 'company_newer', 'stale'),
      `insert into integration_field_mappings (id, connection_id, entity_type, external_field_path, internal_field_path, direction, transform_type, is_required)
        values ('ifm_1', 'conn_lww', 'customer', 'properties.name', 'name', 'bidirectional', 'direct', true)`,
    ],
    answers: [
      {
        method: 'GET',
        url: `${HUB}/companies?limit=100&properties=${HUB_PROPS.companies}`,
        response: { results: [HUB_CONFLICT] },
      },
    ],
  },
  {
    name: 'google calendar: timed and all-day events with the connection defaults',
    payload: { workspaceId: ORG, connectionId: 'conn_gcal', provider: 'google_calendar', syncType: 'incremental' },
    seed: [connection('conn_gcal', 'google_calendar', { settings: { googleCalendarId: 'cal_1' }, cursor: { calendar_event: 'tok_1' } })],
    answers: [
      { method: 'GET', url: `${GOOGLE}&pageToken=tok_1&timeMin=<ts>`, response: { items: GOOGLE_EVENTS, nextPageToken: 'tok_2' } },
      { method: 'GET', url: `${GOOGLE}&pageToken=tok_2&timeMin=<ts>`, response: { items: [] } },
    ],
  },
  {
    name: 'attio: an expired token is refreshed first',
    payload: { workspaceId: ORG, connectionId: 'conn_expired', provider: 'attio', syncType: 'full', entityTypes: ['customer'] },
    env: { ATTIO_CLIENT_ID: 'attio-client', ATTIO_CLIENT_SECRET: 'attio-secret' },
    seed: [connection('conn_expired', 'attio', { tokens: { accessToken: 'stale', refreshToken: 'refresh-1', expiresAt: '2026-01-01T00:00:00.000Z' } })],
    answers: [
      { method: 'POST', url: 'https://app.attio.com/oauth/token', response: { access_token: 'fresh', refresh_token: 'refresh-2' } },
      { method: 'POST', url: `${ATTIO}/objects/companies/records/query`, body: { limit: 500, offset: 0 }, response: { data: [] } },
    ],
  },
  {
    name: 'attio: an expired token without the OAuth client fails the run',
    payload: { workspaceId: ORG, connectionId: 'conn_noclient', provider: 'attio', syncType: 'full' },
    seed: [connection('conn_noclient', 'attio', { tokens: { accessToken: 'stale', refreshToken: 'r', expiresAt: '2026-01-01T00:00:00.000Z' } })],
    answers: [],
  },
  {
    name: 'attio: a provider error fails the step and marks the log and connection',
    payload: { workspaceId: ORG, connectionId: 'conn_err', provider: 'attio', syncType: 'full' },
    seed: [connection('conn_err', 'attio')],
    answers: [
      { method: 'POST', url: `${ATTIO}/objects/companies/records/query`, body: { limit: 500, offset: 0 }, status: 403, response: { code: 'forbidden' } },
    ],
  },
  {
    name: 'an unknown connection fails',
    payload: { workspaceId: ORG, connectionId: 'conn_missing', provider: 'attio', syncType: 'full' },
    seed: [],
    answers: [],
  },
  {
    name: 'a connection without a token fails',
    payload: { workspaceId: ORG, connectionId: 'conn_notoken', provider: 'attio', syncType: 'full' },
    seed: [connection('conn_notoken', 'attio', { tokens: null })],
    answers: [],
  },
  {
    name: 'a provider without an adapter fails after the log',
    payload: { workspaceId: ORG, connectionId: 'conn_sf', provider: 'salesforce', syncType: 'full' },
    seed: [connection('conn_sf', 'salesforce')],
    answers: [],
  },
];

interface Exchange {
  method: string;
  url: string;
  body: unknown;
  status: number;
  response: unknown;
  /** The body as sent, keys in their order (the checksums hash it). */
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

async function run(scenario: Scenario) {
  for (const table of TABLES) await client.exec(`delete from ${table}`);
  for (const statement of scenario.seed) await client.exec(statement);
  const exchanges: Exchange[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = normaliseUrl(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    const answer = scenario.answers.find((a) => a.method === method && a.url === url && JSON.stringify(a.body ?? null) === JSON.stringify(body));
    const status = answer ? (answer.status ?? 200) : 599;
    const response = answer ? answer.response : { message: 'no recorded answer' };
    const responseText = JSON.stringify(response);
    exchanges.push({ method, url, body, status, response, responseText });
    return new Response(responseText, { status, headers: { 'Content-Type': 'application/json' } });
  });
  const steps: string[] = [];
  const step = {
    do: async (name: string, ...rest: unknown[]) => {
      steps.push(name);
      const fn = rest[rest.length - 1] as () => Promise<unknown>;
      return JSON.parse(JSON.stringify((await fn()) ?? null)) as unknown;
    },
    sleep: async () => undefined,
  };
  const workflow = new CrmSyncWorkflow({} as never, (scenario.env ?? {}) as never);
  let error: string | null = null;
  try {
    await (workflow.run as (event: unknown, step: unknown) => Promise<void>)({ payload: scenario.payload, timestamp: new Date(), instanceId: 'i' }, step);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  vi.unstubAllGlobals();
  return {
    name: scenario.name,
    payload: scenario.payload,
    env: scenario.env ?? {},
    seed: scenario.seed,
    steps,
    error,
    exchanges,
    rows: await dump(),
  };
}

describe('Rust parity fixtures', () => {
  it('CRM sync job', async () => {
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
