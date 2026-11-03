/**
 * Parity fixtures for the Rust port of this worker's sweeps
 * (`rust/modules/integrations`), written by the TypeScript code itself.
 *
 * Each scenario seeds the master `bank_feed_connection_index` on pglite,
 * runs `runBankFeedDueSweep` with a `BOOKS_INTERNAL` stub that answers per
 * connection, and records the result, the calls the sweep made and the rows
 * it left. `rust/modules/integrations/tests/bank_feed_due_parity.rs` seeds
 * the same rows into Postgres, runs the Rust sweep on the same answers and
 * compares.
 *
 *   pnpm rust:integration-fixtures                 write the fixtures
 *   pnpm --filter integration-sync-worker test     fails when they are stale
 *
 * `updated_at` is the time of the run on both sides, so it is left out.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it } from 'vitest';
import * as masterSchema from '@weldsuite/db/schema/master';
import { runBankFeedDueSweep, type BankFeedMasterDb } from './bank-feed-due';

const OUT = path.resolve(import.meta.dirname, '../../../../rust/modules/integrations/tests/fixtures/bank_feed_due.json');
const WRITE = process.env.WRITE_RUST_FIXTURES === '1';

const DDL = `
  create table bank_feed_connection_index (
    id varchar(30) primary key,
    provider varchar(30) not null,
    provider_connection_id varchar(255) not null,
    clerk_org_id varchar(255) not null,
    connection_id varchar(30) not null,
    entity_id varchar(30) not null,
    is_active boolean not null default true,
    sync_interval_hours integer not null default 24,
    next_sync_at timestamptz,
    last_triggered_at timestamptz,
    last_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
`;

interface SeedRow {
  id: string;
  provider: string;
  provider_connection_id: string;
  clerk_org_id: string;
  connection_id: string;
  is_active: boolean;
  sync_interval_hours: number;
  next_sync_at: string | null;
}

/** How the stub answers a sync of one connection. */
type Answer = { status: number; body?: unknown } | { throws: string };

interface Scenario {
  name: string;
  now: string;
  limit: number;
  /** false: the worker runs without `BOOKS_INTERNAL`. */
  binding: boolean;
  rows: SeedRow[];
  /** By connection id; a connection not listed answers a plain success. */
  answers: Record<string, Answer>;
}

const NOW = '2026-10-08T12:00:00.000Z';

function row(id: string, overrides: Partial<SeedRow> = {}): SeedRow {
  return {
    id,
    provider: 'plaid',
    provider_connection_id: `item_${id}`,
    clerk_org_id: 'org_1',
    connection_id: `bkc_${id}`,
    is_active: true,
    sync_interval_hours: 24,
    next_sync_at: '2026-10-08T11:00:00.000Z',
    ...overrides,
  };
}

const synced = (connectionId: string) => ({ status: 200, body: { data: { connectionId, status: 'active', added: 2 } } });

const SCENARIOS: Scenario[] = [
  {
    name: 'syncs each due connection in its workspace and schedules the next run',
    now: NOW,
    limit: 25,
    binding: true,
    rows: [row('a'), row('b', { clerk_org_id: 'org_2', sync_interval_hours: 6, next_sync_at: '2026-10-08T10:00:00.000Z' })],
    answers: {},
  },
  {
    name: 'syncs a connection once for its several index rows (Stripe FC), at the shortest interval',
    now: NOW,
    limit: 25,
    binding: true,
    rows: [
      row('fa', { provider: 'stripe_fc', connection_id: 'bkc_fc', provider_connection_id: 'fca_1' }),
      row('fb', { provider: 'stripe_fc', connection_id: 'bkc_fc', provider_connection_id: 'fca_2', sync_interval_hours: 12 }),
    ],
    answers: {},
  },
  {
    name: 'skips rows not yet due and inactive ones; an unscheduled row is due, last',
    now: NOW,
    limit: 25,
    binding: true,
    rows: [
      row('future', { next_sync_at: '2026-10-09T00:00:00.000Z' }),
      row('off', { is_active: false, next_sync_at: '2026-10-08T00:00:00.000Z' }),
      row('unscheduled', { next_sync_at: null }),
      row('early', { next_sync_at: '2026-10-08T01:00:00.000Z' }),
    ],
    answers: {},
  },
  {
    name: 'deactivates the rows of a connection the workspace no longer has, or that is no longer active',
    now: NOW,
    limit: 25,
    binding: true,
    rows: [row('gone'), row('inactive', { clerk_org_id: 'org_2' })],
    answers: {
      bkc_gone: { status: 404, body: { error: { code: 'NOT_FOUND', message: "Bank connection 'bkc_gone' not found" } } },
      bkc_inactive: { status: 200, body: { data: { connectionId: 'bkc_inactive', status: 'revoked', skipped: 'not_active' } } },
    },
  },
  {
    name: 'retries within the hour after a failed call, a thrown one and a retryable error; waits the interval otherwise',
    now: NOW,
    limit: 25,
    binding: true,
    rows: [
      row('down'),
      row('threw', { next_sync_at: '2026-10-08T10:30:00.000Z' }),
      row('limited', { next_sync_at: '2026-10-08T10:00:00.000Z', sync_interval_hours: 6 }),
      row('broken', { next_sync_at: '2026-10-08T09:30:00.000Z', sync_interval_hours: 6 }),
      row('busy', { next_sync_at: '2026-10-08T09:00:00.000Z' }),
    ],
    answers: {
      bkc_down: { status: 503, body: { error: { code: 'INTERNAL_ERROR', message: 'down' } } },
      bkc_threw: { throws: 'connection reset by peer' },
      bkc_limited: {
        status: 200,
        body: { data: { connectionId: 'bkc_limited', status: 'error', error: 'plaid responded 429', retryable: true } },
      },
      bkc_broken: {
        status: 200,
        body: { data: { connectionId: 'bkc_broken', status: 'error', error: `${'x'.repeat(520)}`, retryable: false } },
      },
      bkc_busy: { status: 200, body: { data: { connectionId: 'bkc_busy', status: 'active', skipped: 'in_progress' } } },
    },
  },
  {
    name: 'stops at the limit; the rest wait for the next tick',
    now: NOW,
    limit: 2,
    binding: true,
    rows: [
      row('one', { next_sync_at: '2026-10-08T08:00:00.000Z' }),
      row('two', { next_sync_at: '2026-10-08T09:00:00.000Z' }),
      row('three', { next_sync_at: '2026-10-08T10:00:00.000Z' }),
    ],
    answers: {},
  },
  {
    name: 'does nothing without the binding',
    now: NOW,
    limit: 25,
    binding: false,
    rows: [row('a')],
    answers: {},
  },
];

interface Outcome {
  name: string;
  now: string;
  limit: number;
  binding: boolean;
  rows: SeedRow[];
  answers: Record<string, Answer>;
  result: Record<string, number>;
  calls: Array<{ method: string; path: string; workspace: string | null; body: string | null }>;
  after: Array<Record<string, unknown>>;
}

let shared: PGlite | null = null;

async function run(scenario: Scenario): Promise<Outcome> {
  if (!shared) {
    shared = new PGlite();
    await shared.exec(DDL);
  }
  const client = shared;
  await client.exec('delete from bank_feed_connection_index');
  for (const r of scenario.rows) {
    await client.query(
      `insert into bank_feed_connection_index (id, provider, provider_connection_id, clerk_org_id, connection_id, entity_id, is_active, sync_interval_hours, next_sync_at)
       values ($1, $2, $3, $4, $5, 'ent_1', $6, $7, $8)`,
      [r.id, r.provider, r.provider_connection_id, r.clerk_org_id, r.connection_id, r.is_active, r.sync_interval_hours, r.next_sync_at],
    );
  }
  const master = drizzle(client, { schema: masterSchema }) as unknown as BankFeedMasterDb;
  const calls: Outcome['calls'] = [];
  const BOOKS_INTERNAL = {
    fetch: async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      calls.push({
        method: (init.method ?? 'GET').toUpperCase(),
        path: parsed.pathname,
        workspace: new Headers(init.headers).get('X-Workspace-Id'),
        body: typeof init.body === 'string' ? init.body : null,
      });
      const id = decodeURIComponent(parsed.pathname.split('/')[3] ?? '');
      const answer = scenario.answers[id] ?? synced(id);
      if ('throws' in answer) throw new Error(answer.throws);
      return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
    },
  } as unknown as Fetcher;
  const result = await runBankFeedDueSweep(master, scenario.binding ? { BOOKS_INTERNAL } : {}, new Date(scenario.now), scenario.limit);
  const { rows } = await client.query<Record<string, unknown>>(
    `select id, is_active, next_sync_at, last_triggered_at, last_error from bank_feed_connection_index order by id`,
  );
  return {
    ...scenario,
    result: { ...result },
    calls,
    after: rows.map((r) => ({
      id: r.id,
      is_active: r.is_active,
      next_sync_at: r.next_sync_at instanceof Date ? r.next_sync_at.toISOString() : null,
      last_triggered_at: r.last_triggered_at instanceof Date ? r.last_triggered_at.toISOString() : null,
      last_error: r.last_error ?? null,
    })),
  };
}

describe('Rust parity fixtures', () => {
  it('bank feed due sweep', async () => {
    const outcomes: Outcome[] = [];
    for (const scenario of SCENARIOS) outcomes.push(await run(scenario));
    const text = `${JSON.stringify(outcomes, null, 2)}\n`;
    if (WRITE) {
      mkdirSync(path.dirname(OUT), { recursive: true });
      writeFileSync(OUT, text);
      return;
    }
    expect(existsSync(OUT), `${OUT} is missing: run pnpm rust:integration-fixtures`).toBe(true);
    expect(JSON.parse(readFileSync(OUT, 'utf8')), 'stale fixtures: run pnpm rust:integration-fixtures').toEqual(outcomes);
  }, 60_000);
});
