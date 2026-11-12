/**
 * The report schedule sweep on the due index, end to end: `runReportScheduleSweep(env, now)`
 * lists the SQLite D1 `workspace_due_index` (kind `desk_report`), opens only the
 * due workspace (tenant: pglite), mails the schedules that came due through a
 * `SEND_EMAIL` stub, records how each went, moves `nextRunAt` to the next slot
 * and stores when the workspace is next due, or drops the row.
 *
 * The outbound mail guard runs for real; its ledger (`OUTBOUND_LEDGER`) is a
 * stub that allows, refuses or breaks, by recipient.
 *
 * In conformance mode (CONFORMANCE_TARGET=rust) each tick also runs on the
 * Rust server (`weldsuite cron desk-report-sweep`), through `conformanceSweep`:
 * result, mail, ledger calls and due index must match, and the assertions
 * below check Rust's run. Both runs call the ledger stub, so the assertions
 * on its calls read every call alike.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv, createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { createSendEmailStub } from '@weldsuite/worker-kit/testing/send-email';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { conformanceSweep } from '@weldsuite/worker-kit/testing/conformance-cron';
import { readSent } from '../test/sent-mail';

// The sweep opens the tenant itself; the guard resolves the workspace through the master database.
const dbs = vi.hoisted(() => ({ tenant: null as unknown, master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getTenantDbForWorkspace: async () => dbs.tenant,
    getMasterDb: () => dbs.master,
    getWorkspaceForOrg: async (_env: unknown, orgId: string) => {
      if (orgId !== 'org_desk_reports') throw new Error(`workspace not found: ${orgId}`);
      return { id: 'ws_desk_reports', clerkOrgId: 'org_desk_reports' };
    },
  };
});

import { REPORT_GONE_MESSAGE, REPORT_HELD_BACK_MESSAGE } from '../services/desk-report-schedules';
import { runReportScheduleSweep, SCHEDULES_PER_WORKSPACE } from './report-schedule-sweep';

const MIGRATION = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'),
  'utf8',
);

const ORG = 'org_desk_reports';
const WORKSPACE = 'ws_desk_reports';
const NOW = new Date('2026-03-15T08:00:30Z');
const MINUTE = 60_000;
const { helpdeskReportSchedules: schedules } = schema;

type ReserveRequest = { source: string; kind: string; sender: string; recipients: string[] };
type LedgerDecision = {
  allow: boolean;
  mode: 'enforce';
  reservationId: string | null;
  denial?: Record<string, unknown>;
};
const ALLOW: LedgerDecision = { allow: true, mode: 'enforce', reservationId: 'res_1' };

/**
 * The workspace's `OUTBOUND_LEDGER`: `reserve` answers `decide(request)`, which
 * allows by default; a test makes it refuse or throw. It answers by request
 * (never by call order): both runs call it in conformance mode.
 */
const ledger = {
  decide: (_request: ReserveRequest): LedgerDecision => ALLOW,
  calls: { reserve: [] as unknown[][], commit: [] as unknown[][], release: [] as unknown[][] },
};
const ledgerStub = {
  reserve: async (...args: unknown[]) => {
    ledger.calls.reserve.push(args);
    return ledger.decide(args[1] as ReserveRequest);
  },
  commit: async (...args: unknown[]) => {
    ledger.calls.commit.push(args);
  },
  release: async (...args: unknown[]) => {
    ledger.calls.release.push(args);
  },
};
const ledgerNamespace = { idFromName: (name: string) => name, get: () => ledgerStub };

/** The reserve requests the guard sent (`[subject, request]` per call). */
const reserved = () => ledger.calls.reserve.map((args) => args[1] as ReserveRequest);

let db: Database;
let master: MasterDatabase;
let close: () => Promise<void>;
let mail = createSendEmailStub();

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  close = handle.close;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  dbs.tenant = db;
  dbs.master = master;
  await master.insert(masterSchema.workspaces).values({
    id: WORKSPACE,
    name: 'Desk reports',
    slug: 'desk-reports',
    clerkOrgId: ORG,
  } as typeof masterSchema.workspaces.$inferInsert);
  await db.insert(schema.workspaceMembers).values({
    id: 'wm_rep_sanne',
    userId: 'user_sanne',
    name: 'Sanne',
    email: 'sanne@example.com',
  });
  await db.insert(schema.helpdeskAnalyticsReports).values([
    { id: 'rpt_sweep_live', title: 'Live report', chartCount: 0 },
    { id: 'rpt_sweep_gone', title: 'Gone report', chartCount: 0, deletedAt: new Date('2026-03-01T00:00:00Z') },
  ]);
}, 120_000);

afterAll(async () => {
  if (close) await close();
});

beforeEach(async () => {
  await db.delete(schedules);
  mail = createSendEmailStub({ 'bad@example.com': 'E_RECIPIENT_SUPPRESSED' });
  ledger.decide = () => ALLOW;
  for (const list of Object.values(ledger.calls)) list.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    ENVIRONMENT: 'test',
    // The guard looks the workspace up only on a worker that has a master database.
    DATABASE_URL_MASTER: 'postgres://test',
    NEON_API_KEY: 'test',
    SCHEDULE_INDEX: createSqliteD1(MIGRATION),
    WORKSPACE_CACHE: createMemoryKv(),
    SEND_EMAIL: mail,
    OUTBOUND_LEDGER: ledgerNamespace,
    ...overrides,
  };
}

type Env = ReturnType<typeof makeEnv>;

/** `runReportScheduleSweep(env, now)`, on both backends in conformance mode. */
function sweep(env: Env, now: Date = NOW) {
  return conformanceSweep({
    job: 'desk-report-sweep',
    now,
    tenantDb: db,
    masterDb: master as unknown as Database,
    env: env as unknown as Record<string, unknown>,
    mailBindings: true,
    dueIndex: { d1: env.SCHEDULE_INDEX as never, kind: 'desk_report' },
    kv: env.WORKSPACE_CACHE as object,
    workspaces: { [WORKSPACE]: ORG },
    runTypeScript: async (tenantDb, runEnv) => {
      dbs.tenant = tenantDb;
      try {
        return await runReportScheduleSweep(runEnv as never, now);
      } finally {
        dbs.tenant = db;
      }
    },
    // The sweep publishes no entity events.
    takeTypeScriptEvents: () => [],
  });
}

/** How many runs a tick has: Rust's and TypeScript's in conformance mode. */
const RUNS = conformanceTarget() ? 2 : 1;

async function addSchedule(id: string, fields: Partial<typeof schedules.$inferInsert> = {}) {
  await db.insert(schedules).values({
    id,
    name: `Schedule ${id}`,
    range: 'last_7_days',
    frequency: 'daily',
    hour: 8,
    timezone: 'UTC',
    recipients: ['lead@example.com'],
    attachCsv: true,
    locale: 'en',
    enabled: true,
    createdById: 'user_sanne',
    // Due a minute before the sweep.
    nextRunAt: new Date(NOW.getTime() - MINUTE),
    ...fields,
  });
}

const rowOf = async (id: string) => (await db.select().from(schedules).where(eq(schedules.id, id)))[0]!;

/** The due index's time for the workspace, in ms; null when it has no row. */
async function dueAt(env: Env): Promise<number | null> {
  const { results } = await (env.SCHEDULE_INDEX as never as {
    prepare(q: string): { bind(...v: unknown[]): { all<T>(): Promise<{ results: T[] }> } };
  })
    .prepare('SELECT next_due_at FROM workspace_due_index WHERE kind = ? AND workspace_id = ?')
    .bind('desk_report', ORG)
    .all<{ next_due_at: number }>();
  return results[0] ? Number(results[0].next_due_at) : null;
}

const swept = new WeakSet<object>();

/** Mark the workspace due in the test's D1 index and, for Rust, in the master one. */
async function markDue(env: Env, at: Date) {
  // The harness clears the master index the first time it sees a D1 (a new,
  // empty index): let that happen before the row goes in.
  if (!swept.has(env.SCHEDULE_INDEX)) {
    swept.add(env.SCHEDULE_INDEX);
    expect(await sweep(env, new Date(0))).toMatchObject({ due: 0, sent: 0 });
  }
  await markWorkspaceDue(env.SCHEDULE_INDEX as never, 'desk_report', ORG, at);
  if (conformanceTarget()) {
    await master.execute(sql`
      insert into workspace_due_index (kind, workspace_id, next_due_at, updated_at, version)
      values ('desk_report', ${WORKSPACE}, ${at.toISOString()}::timestamptz, now(), 1)
      on conflict (kind, workspace_id) do update set
        next_due_at = least(workspace_due_index.next_due_at, excluded.next_due_at)`);
  }
}

describe('desk report schedule sweep on the due index', () => {
  it('sends a due schedule once with its CSV, records it and moves to the next slot', async () => {
    await addSchedule('rsch_a');
    const env = makeEnv();
    await markDue(env, new Date(NOW.getTime() - MINUTE));

    expect(await sweep(env)).toMatchObject({ due: 1, processed: 1, failed: 0, sent: 1, sendFailed: 0, disabled: 0 });

    const sent = readSent(mail);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(['lead@example.com']);
    expect(sent[0]!.subject).toBe('WeldDesk report: Overview (Mar 9, 2026 to Mar 15, 2026)');
    expect(sent[0]!.text).toContain('Sanne scheduled this report ("Schedule rsch_a") in WeldDesk.');
    expect(sent[0]!.text).toContain('https://app-test.weldsuite.org/w/org_desk_reports/welddesk/reports');
    expect(sent[0]!.attachments).toHaveLength(1);
    expect(sent[0]!.attachments[0]!.filename).toBe('welddesk-overview-last_7_days-2026-03-15.csv');
    expect(sent[0]!.attachments[0]!.content).toContain('section,label,metric,value,previous');

    const row = await rowOf('rsch_a');
    expect(row.lastStatus).toBe('sent');
    expect(row.lastError).toBeNull();
    expect(row.lastRunAt?.toISOString()).toBe(NOW.toISOString());
    // Daily at 08:00 UTC: 08:00:30 is past it, so the next slot is tomorrow.
    expect(row.nextRunAt?.toISOString()).toBe('2026-03-16T08:00:00.000Z');
    expect(await dueAt(env)).toBe(Date.parse('2026-03-16T08:00:00Z'));

    // Nothing is due any more: a second tick sends nothing.
    expect(await sweep(env)).toMatchObject({ due: 0, sent: 0 });
    expect(mail.sent).toHaveLength(1);
  });

  it('leaves the CSV off when the schedule says so', async () => {
    await addSchedule('rsch_nocsv', { attachCsv: false, locale: 'nl' });
    const env = makeEnv();
    await markDue(env, NOW);
    await sweep(env);
    const [message] = readSent(mail);
    expect(message!.attachments).toEqual([]);
    expect(message!.subject).toBe('WeldDesk-rapport: Overzicht (9 mrt 2026 t/m 15 mrt 2026)');
  });

  it('sends a saved report with a link to it', async () => {
    await addSchedule('rsch_saved', { reportId: 'rpt_sweep_live' });
    const env = makeEnv();
    await markDue(env, NOW);
    await sweep(env);
    const [message] = readSent(mail);
    expect(message!.subject).toBe('WeldDesk report: Live report (Mar 15, 2026)');
    expect(message!.text).toContain('/welddesk/reports/custom/rpt_sweep_live');
    expect(message!.attachments[0]!.filename).toBe('welddesk-report-live-report-2026-03-15.csv');
  });

  it('does not touch schedules that are not due or are switched off', async () => {
    await addSchedule('rsch_later', { nextRunAt: new Date(NOW.getTime() + 60 * MINUTE) });
    await addSchedule('rsch_off', { enabled: false, nextRunAt: null });
    const env = makeEnv();
    await markDue(env, NOW);

    expect(await sweep(env)).toMatchObject({ due: 1, processed: 1, sent: 0 });
    expect(mail.sent).toHaveLength(0);
    expect((await rowOf('rsch_later')).lastRunAt).toBeNull();
    expect((await rowOf('rsch_off')).lastRunAt).toBeNull();
    // The workspace is due again when the earliest enabled schedule is.
    expect(await dueAt(env)).toBe(NOW.getTime() + 60 * MINUTE);
  });

  it('isolates a failed send: the others still go out and the failed one waits for its next slot', async () => {
    await addSchedule('rsch_bad', { recipients: ['bad@example.com'], nextRunAt: new Date(NOW.getTime() - 2 * MINUTE) });
    await addSchedule('rsch_ok', { recipients: ['ok@example.com'] });
    const env = makeEnv();
    await markDue(env, NOW);

    expect(await sweep(env)).toMatchObject({ due: 1, sent: 1, sendFailed: 1, disabled: 0 });

    const bad = await rowOf('rsch_bad');
    expect(bad.lastStatus).toBe('failed');
    expect(bad.lastError).toBeTruthy();
    expect(bad.nextRunAt?.toISOString()).toBe('2026-03-16T08:00:00.000Z');
    expect(bad.enabled).toBe(true);
    expect((await rowOf('rsch_ok')).lastStatus).toBe('sent');
    expect(readSent(mail).map((m) => m.to[0])).toEqual(['ok@example.com']);

    // No tight retry loop: another tick in the same minute sends nothing more.
    await sweep(env, new Date(NOW.getTime() + MINUTE));
    expect(mail.sent).toHaveLength(1);
  });

  it('fails every schedule, and still advances them, when the worker has no mail binding', async () => {
    await addSchedule('rsch_nomail');
    const env = makeEnv({ SEND_EMAIL: undefined });
    await markDue(env, NOW);
    expect(await sweep(env)).toMatchObject({ sendFailed: 1 });
    const row = await rowOf('rsch_nomail');
    expect(row.lastStatus).toBe('failed');
    expect(row.lastError).toMatch(/not configured/);
    expect(row.nextRunAt?.toISOString()).toBe('2026-03-16T08:00:00.000Z');
  });

  it('turns a schedule off when its saved report was deleted, and drops the workspace from the index', async () => {
    await addSchedule('rsch_gone', { reportId: 'rpt_sweep_gone' });
    const env = makeEnv();
    await markDue(env, NOW);

    expect(await sweep(env)).toMatchObject({ due: 1, sent: 0, sendFailed: 0, disabled: 1 });

    const row = await rowOf('rsch_gone');
    expect(row.enabled).toBe(false);
    expect(row.nextRunAt).toBeNull();
    expect(row.lastStatus).toBe('failed');
    expect(row.lastError).toBe(REPORT_GONE_MESSAGE);
    expect(mail.sent).toHaveLength(0);
    expect(await dueAt(env)).toBeNull();
  });

  it('does a bounded number of schedules per workspace and keeps the rest due', async () => {
    for (let i = 0; i < SCHEDULES_PER_WORKSPACE + 5; i += 1) {
      await addSchedule(`rsch_many_${String(i).padStart(2, '0')}`, {
        nextRunAt: new Date(NOW.getTime() - (SCHEDULES_PER_WORKSPACE + 5 - i) * MINUTE),
      });
    }
    const env = makeEnv();
    await markDue(env, NOW);

    expect(await sweep(env)).toMatchObject({ sent: SCHEDULES_PER_WORKSPACE });
    expect(mail.sent).toHaveLength(SCHEDULES_PER_WORKSPACE);
    // The workspace stays due (in the past) for the five that did not fit; the oldest went first.
    expect(await dueAt(env)).toBeLessThanOrEqual(NOW.getTime());
    expect((await rowOf('rsch_many_00')).lastStatus).toBe('sent');
    expect((await rowOf(`rsch_many_${SCHEDULES_PER_WORKSPACE + 4}`)).lastStatus).toBeNull();

    // The next tick sends the rest.
    expect(await sweep(env)).toMatchObject({ sent: 5 });
    expect(mail.sent).toHaveLength(SCHEDULES_PER_WORKSPACE + 5);
  });

  it('asks the outbound guard as the desk_report source and commits what went out', async () => {
    await addSchedule('rsch_guard', { recipients: ['a@example.com', 'b@example.com'] });
    const env = makeEnv();
    await markDue(env, NOW);
    await sweep(env);
    // Asked once per run, as WeldSuite's own sender (no sender address to count).
    expect(ledger.calls.reserve).toHaveLength(RUNS);
    for (const [subject, request] of ledger.calls.reserve as Array<[unknown, ReserveRequest]>) {
      expect(subject).toMatchObject({ kind: 'workspace', workspaceId: WORKSPACE, clerkOrgId: ORG });
      expect(request).toMatchObject({
        source: 'desk_report',
        kind: 'new_thread',
        sender: '',
        recipients: ['a@example.com', 'b@example.com'],
      });
    }
    expect(ledger.calls.commit).toHaveLength(RUNS);
    expect(ledger.calls.release).toHaveLength(0);
  });

  it('releases the reservation when the send fails', async () => {
    await addSchedule('rsch_release', { recipients: ['bad@example.com'] });
    const env = makeEnv();
    await markDue(env, NOW);
    await sweep(env);
    expect(ledger.calls.release).toHaveLength(RUNS);
    expect(ledger.calls.commit).toHaveLength(0);
  });

  it('records a refusal as a failed run, advances it, and still sends the others', async () => {
    await addSchedule('rsch_refused', { recipients: ['held@example.com'], nextRunAt: new Date(NOW.getTime() - 2 * MINUTE) });
    await addSchedule('rsch_fine', { recipients: ['fine@example.com'] });
    ledger.decide = (request) =>
      request.recipients[0] === 'held@example.com'
        ? { allow: false, mode: 'enforce', reservationId: null, denial: { code: 'SENDING_LIMITED', window: 'day', limit: 100, used: 100 } }
        : ALLOW;
    const env = makeEnv();
    await markDue(env, NOW);

    expect(await sweep(env)).toMatchObject({ failed: 0, sent: 1, sendFailed: 1 });

    const refused = await rowOf('rsch_refused');
    expect(refused.lastStatus).toBe('failed');
    expect(refused.lastError).toBe(REPORT_HELD_BACK_MESSAGE);
    expect(refused.enabled).toBe(true);
    expect(refused.nextRunAt?.toISOString()).toBe('2026-03-16T08:00:00.000Z');
    expect((await rowOf('rsch_fine')).lastStatus).toBe('sent');
    expect(readSent(mail).map((m) => m.to[0])).toEqual(['fine@example.com']);
    // Both were asked about in every run; only the one that went out is counted.
    expect(reserved().filter((r) => r.recipients[0] === 'held@example.com')).toHaveLength(RUNS);
    expect(reserved().filter((r) => r.recipients[0] === 'fine@example.com')).toHaveLength(RUNS);
    expect(ledger.calls.commit).toHaveLength(RUNS);
  });

  it('sends anyway when the guard itself breaks', async () => {
    await addSchedule('rsch_open');
    const env = makeEnv();
    await markDue(env, NOW);
    ledger.decide = () => {
      throw new Error('ledger unreachable');
    };
    expect(await sweep(env)).toMatchObject({ sent: 1 });
    expect(mail.sent).toHaveLength(1);
    // Nothing was reserved, so there is nothing to count.
    expect(ledger.calls.commit).toHaveLength(0);
  });

  it('opens no workspace that is not in the index', async () => {
    await addSchedule('rsch_unlisted');
    const env = makeEnv();
    expect(await sweep(env)).toMatchObject({ due: 0, processed: 0, sent: 0 });
    expect(mail.sent).toHaveLength(0);
  });
});
