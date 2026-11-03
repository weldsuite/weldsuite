/**
 * Parity fixtures for the Rust port of the send engine
 * (`rust/crates/reach-domain/src/engine`), written by the TypeScript code
 * itself.
 *
 * Runs the scheduler's pure rules and whole send ticks (`runSendTick`) on
 * pglite, each tick on its own seeded workspace with SMTP answering by
 * recipient, and records what they did: the tick's result, the rows the
 * tick left, the entity events and the SMTP sends.
 * `rust/crates/reach-domain/tests/send_engine_parity.rs` seeds the same rows
 * into Postgres, runs the Rust tick on the same input and compares.
 *
 *   pnpm rust:reach-engine-fixtures      write the fixtures
 *   pnpm --filter reach-api test         fails when they are stale
 *
 * Values that differ on every run are placeholders on both sides: generated
 * ids (`<rmsg:1>`), generated Message-IDs (`<mid:1>@domain`), times written
 * by the wall clock rather than the tick's clock (`<ts>`) and sealed logins
 * (`<sealed>`). Seeded rows have fixed ids, so the rest is stable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import { resolveWeldReachLimits, type WeldReachLimits } from '@weldsuite/app-api-client/schemas/reach';
import {
  reachCampaignMailboxes,
  reachCampaigns,
  reachCampaignSteps,
  reachEnrollments,
  reachMailboxes,
  reachMessages,
  reachSuppressions,
} from '@weldsuite/db/schema';

const smtp = vi.hoisted(() => ({
  answers: {} as Record<string, unknown>,
  calls: [] as Array<{ host: string; port: number; secure: boolean; username: string; from: string; to: string[] }>,
}));

vi.mock('@weldsuite/smtp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/smtp')>()),
  sendMail: async (
    config: { host: string; port: number; secure: boolean; username: string },
    envelope: { from: string; to: string[] },
  ) => {
    smtp.calls.push({ host: config.host, port: config.port, secure: config.secure, username: config.username, from: envelope.from, to: envelope.to });
    const answer = smtp.answers[envelope.to[0] ?? ''];
    if (answer === 'throw') throw new Error('socket closed');
    return answer ?? { ok: true, response: '250 2.0.0 OK', accepted: envelope.to };
  },
}));

import { runSendTick } from '../services/send-tick';
import {
  assessMailboxes,
  evaluateCampaignGate,
  gapEndsAt,
  jitterFraction,
  mailboxCapacity,
  nextStepDueAt,
  planSends,
  type PlanCampaign,
  type PlanContext,
  type PlanMailbox,
} from '../services/scheduler';
import { resetReach, seedEnrollment, seedMailbox, seedOutbound, seedProspect, seedSettings, testEnv } from '../test-support/reach';

const OUT_DIR = path.resolve(import.meta.dirname, '../../../../../rust/crates/reach-domain/tests/fixtures');
const WRITE = process.env.WRITE_RUST_FIXTURES === '1';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const T0 = new Date('2026-10-12T10:00:00.000Z'); // Monday
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (ms: number) => new Date(T0.getTime() + ms);

// ---------------------------------------------------------------------------
// Normalisation (mirrored in the Rust test)
// ---------------------------------------------------------------------------

/** `generateId`: an 8-character time and 8 random characters; seeded ids are shorter. */
const GENERATED_ID = /^(rmsg|rsup)_[0-9a-z]{12,}$/;
const MESSAGE_ID = /^[0-9a-f]{32}\.[0-9a-z]+@(.+)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** Written by the wall clock (a database default, `new Date()`), not the tick's clock. */
const WALL_CLOCK = '2026-11';

class Placeholders {
  private readonly ids = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  of(prefix: string, value: string): string {
    const known = this.ids.get(value);
    if (known) return known;
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    const placeholder = `<${prefix}:${n}>`;
    this.ids.set(value, placeholder);
    return placeholder;
  }

  text(value: string, key: string): Json {
    if (GENERATED_ID.test(value)) return this.of(value.slice(0, 4), value);
    if (key === 'references') return value.split(' ').map((v) => this.text(v, '')).join(' ');
    const mid = MESSAGE_ID.exec(value);
    if (mid) return `${this.of('mid', value)}@${mid[1]}`;
    if (ISO.test(value)) return value >= WALL_CLOCK ? '<ts>' : new Date(value).toISOString();
    return value;
  }

  json(value: unknown, key = ''): Json {
    if (value === undefined || value === null) return null;
    if (value instanceof Date) return this.text(value.toISOString(), key);
    if (Array.isArray(value)) return value.map((v) => this.json(v));
    if (typeof value === 'object') {
      const out: Record<string, Json> = {};
      for (const k of Object.keys(value).sort()) {
        const v = (value as Record<string, unknown>)[k];
        if (v === undefined) continue;
        if ((k === 'smtpCredentials' || k === 'imapCredentials') && v !== null) {
          out[k] = '<sealed>';
          continue;
        }
        out[k] = this.json(v, k);
      }
      return out;
    }
    if (typeof value === 'string') return this.text(value, key);
    return value as Json;
  }
}

// ---------------------------------------------------------------------------
// Seeding: fixed ids, so placeholders and row order are stable
// ---------------------------------------------------------------------------

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

interface CampaignSeed {
  id: string;
  mailboxIds: string[];
  steps?: Array<{ subject: string; body: string; delayDays?: number; delayHours?: number; replyInThread?: boolean }>;
  campaign?: Partial<typeof reachCampaigns.$inferInsert>;
}

async function campaign(seed: CampaignSeed): Promise<void> {
  await db.insert(reachCampaigns).values({
    id: seed.id,
    name: `Campaign ${seed.id}`,
    status: 'active',
    timezone: 'UTC',
    sendDays: [1, 2, 3, 4, 5, 6, 7],
    windowStart: '00:00',
    windowEnd: '23:59',
    dailyLimit: 100,
    minGapMinutes: 8,
    ...seed.campaign,
  });
  const steps = seed.steps ?? [{ subject: 'Hello {{firstName}}', body: 'Hi {{firstName}}, quick question about {{companyName}}.' }];
  for (const [order, s] of steps.entries()) {
    await db.insert(reachCampaignSteps).values({
      id: `${seed.id}_s${order}`,
      campaignId: seed.id,
      order,
      subject: s.subject,
      body: s.body,
      delayDays: s.delayDays ?? 3,
      delayHours: s.delayHours ?? 0,
      replyInThread: s.replyInThread ?? true,
    });
  }
  for (const [i, mailboxId] of seed.mailboxIds.entries()) {
    await db.insert(reachCampaignMailboxes).values({ id: `${seed.id}_m${i}`, campaignId: seed.id, mailboxId });
  }
}

const mailbox = (id: string, overrides: Parameters<typeof seedMailbox>[1] = {}) =>
  seedMailbox(db, { id, email: `${id.slice(5)}@getacme.com`, inboundToken: `tok${id.slice(5)}`, ...overrides });
const prospect = (id: string, overrides: Parameters<typeof seedProspect>[1] = {}) =>
  seedProspect(db, { id, email: `${id.slice(5)}@bigco.io`, ...overrides });
const enrollment = (id: string, campaignId: string, prospectId: string, overrides: Parameters<typeof seedEnrollment>[3] = {}) =>
  seedEnrollment(db, campaignId, prospectId, { id, nextSendAt: at(-HOUR), ...overrides });
const sent = (id: string, mailboxId: string, overrides: Parameters<typeof seedOutbound>[2] = {}) =>
  seedOutbound(db, mailboxId, {
    id,
    messageIdHeader: `${id}@getacme.com`,
    threadKey: `${id}@getacme.com`,
    createdAt: at(-2 * HOUR),
    sentAt: at(-2 * HOUR),
    ...overrides,
  });

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  now?: Date;
  limits?: Partial<WeldReachLimits>;
  /** SMTP's answer by recipient (default: 250 OK); 'throw' throws. */
  answers?: Record<string, unknown>;
  seed: () => Promise<void>;
}

const REFUSED = (stage: string, response: string, extra: Record<string, unknown> = {}) => ({
  ok: false,
  permanent: response.startsWith('5'),
  stage,
  response,
  recipientRejected: false,
  authFailed: false,
  ...extra,
});

const SCENARIOS: Scenario[] = [
  {
    name: 'first email of a two-step sequence',
    async seed() {
      await mailbox('rmbx_a');
      await campaign({
        id: 'rcmp_a',
        mailboxIds: ['rmbx_a'],
        steps: [
          { subject: 'Hello {{firstName}}', body: 'Hi {{firstName}}, a question for {{companyName}}.\n\n{{senderFirstName}}' },
          { subject: 'Following up', body: 'Any thoughts?', delayDays: 3 },
        ],
      });
      await prospect('rpro_jane');
      await enrollment('renr_1', 'rcmp_a', 'rpro_jane');
    },
  },
  {
    name: 'last step completes the enrollment and the campaign',
    async seed() {
      await mailbox('rmbx_a');
      await campaign({ id: 'rcmp_a', mailboxIds: ['rmbx_a'] });
      await prospect('rpro_jane');
      await enrollment('renr_1', 'rcmp_a', 'rpro_jane');
    },
  },
  {
    name: 'a follow-up replies in the thread',
    async seed() {
      await mailbox('rmbx_a', { lastSentAt: at(-2 * HOUR) });
      await campaign({
        id: 'rcmp_a',
        mailboxIds: ['rmbx_a'],
        steps: [
          { subject: 'Hello {{firstName}}', body: 'Hi {{firstName}}.' },
          { subject: 'Ignored subject', body: 'Bumping this.', delayDays: 2 },
          { subject: 'Last one', body: 'Closing the loop.', delayDays: 2, replyInThread: false },
        ],
      });
      await prospect('rpro_jane');
      await enrollment('renr_1', 'rcmp_a', 'rpro_jane', { currentStep: 1, mailboxId: 'rmbx_a', threadRootMessageId: 'rmsg_seed1@getacme.com' });
      await sent('rmsg_seed1', 'rmbx_a', { campaignId: 'rcmp_a', enrollmentId: 'renr_1', stepId: 'rcmp_a_s0', prospectId: 'rpro_jane' });
    },
  },
  {
    name: 'a closed window defers to its next opening',
    async seed() {
      await mailbox('rmbx_a');
      await campaign({ id: 'rcmp_a', mailboxIds: ['rmbx_a'], campaign: { windowStart: '13:00', windowEnd: '17:00', timezone: 'Europe/Amsterdam', sendDays: [1, 2, 3, 4, 5] } });
      await prospect('rpro_jane');
      await enrollment('renr_1', 'rcmp_a', 'rpro_jane');
    },
  },
  {
    name: 'the campaign and the workspace daily limits',
    limits: { maxDailySends: 3 },
    async seed() {
      await mailbox('rmbx_a');
      await mailbox('rmbx_b');
      await campaign({ id: 'rcmp_a', mailboxIds: ['rmbx_a'], campaign: { dailyLimit: 1 } });
      await campaign({ id: 'rcmp_b', mailboxIds: ['rmbx_b'] });
      await sent('rmsg_seed1', 'rmbx_a', { campaignId: 'rcmp_a', sentAt: at(-HOUR) });
      await sent('rmsg_seed2', 'rmbx_b', { campaignId: 'rcmp_b', sentAt: at(-HOUR) });
      await sent('rmsg_seed3', 'rmbx_b', { sentAt: at(-HOUR) });
      for (const p of ['rpro_a1', 'rpro_b1']) await prospect(p);
      await enrollment('renr_a1', 'rcmp_a', 'rpro_a1');
      await enrollment('renr_b1', 'rcmp_b', 'rpro_b1');
    },
  },
  {
    name: 'capped, paused and gap-blocked mailboxes',
    async seed() {
      await mailbox('rmbx_capped', { dailyCap: 1, rampCurrent: 1 });
      await mailbox('rmbx_paused', { status: 'paused' });
      await mailbox('rmbx_gap', { lastSentAt: at(-2 * MINUTE) });
      await campaign({ id: 'rcmp_a', mailboxIds: ['rmbx_capped'] });
      await campaign({ id: 'rcmp_b', mailboxIds: ['rmbx_paused', 'rmbx_gap'] });
      await sent('rmsg_seed1', 'rmbx_capped', { campaignId: 'rcmp_a', sentAt: at(-HOUR) });
      for (const p of ['rpro_1', 'rpro_2', 'rpro_3', 'rpro_4']) await prospect(p);
      await enrollment('renr_1', 'rcmp_a', 'rpro_1', { mailboxId: 'rmbx_capped', currentStep: 0 });
      await enrollment('renr_2', 'rcmp_a', 'rpro_2');
      await enrollment('renr_3', 'rcmp_b', 'rpro_3', { mailboxId: 'rmbx_paused' });
      await enrollment('renr_4', 'rcmp_b', 'rpro_4');
    },
  },
  {
    name: 'several prospects share two mailboxes, one send each',
    async seed() {
      await mailbox('rmbx_a', { lastSentAt: at(-3 * HOUR) });
      await mailbox('rmbx_b', { lastSentAt: at(-5 * HOUR) });
      await campaign({ id: 'rcmp_a', mailboxIds: ['rmbx_a', 'rmbx_b'] });
      for (const [i, p] of ['rpro_1', 'rpro_2', 'rpro_3', 'rpro_4'].entries()) {
        await prospect(p);
        await enrollment(`renr_${i + 1}`, 'rcmp_a', p, { nextSendAt: at(-HOUR + i * MINUTE) });
      }
    },
  },
  {
    name: 'triage settles what needs no send',
    async seed() {
      await mailbox('rmbx_a');
      await mailbox('rmbx_b');
      await mailbox('rmbx_c');
      await campaign({
        id: 'rcmp_a',
        mailboxIds: ['rmbx_a', 'rmbx_b', 'rmbx_c'],
        steps: [{ subject: 'Hi {{firstName}}', body: 'About your role as {{title}}.' }, { subject: 'Again', body: 'x' }],
      });
      await prospect('rpro_deleted', { deletedAt: at(-HOUR) });
      await prospect('rpro_suppressed');
      await prospect('rpro_bounced', { email: 'bounced@oldco.io', companyDomain: 'oldco.io', title: 'CEO' });
      await prospect('rpro_gmail', { email: 'jane.doe@gmail.com', companyDomain: 'gmail.com', title: 'CEO' });
      await prospect('rpro_notitle');
      await prospect('rpro_resent', { title: 'CTO' });
      await prospect('rpro_failing', { title: 'CFO' });
      await prospect('rpro_inflight', { title: 'COO' });
      await prospect('rpro_nostep', { title: 'CMO' });
      await db.insert(reachSuppressions).values([
        { id: 'rsup_seed1', value: 'suppressed@bigco.io', type: 'email', reason: 'unsubscribed' },
        { id: 'rsup_seed2', value: 'oldco.io', type: 'domain', reason: 'bounced' },
      ]);
      await enrollment('renr_deleted', 'rcmp_a', 'rpro_deleted');
      await enrollment('renr_suppressed', 'rcmp_a', 'rpro_suppressed');
      await enrollment('renr_bounced', 'rcmp_a', 'rpro_bounced');
      await enrollment('renr_gmail', 'rcmp_a', 'rpro_gmail');
      await enrollment('renr_notitle', 'rcmp_a', 'rpro_notitle');
      await enrollment('renr_resent', 'rcmp_a', 'rpro_resent');
      await enrollment('renr_failing', 'rcmp_a', 'rpro_failing');
      await enrollment('renr_inflight', 'rcmp_a', 'rpro_inflight');
      await enrollment('renr_nostep', 'rcmp_a', 'rpro_nostep', { currentStep: 5 });
      // A crash after the SMTP reply: the step went out already.
      await sent('rmsg_seed1', 'rmbx_a', { campaignId: 'rcmp_a', enrollmentId: 'renr_resent', stepId: 'rcmp_a_s0' });
      for (let i = 0; i < 5; i++) {
        await sent(`rmsg_fail${i}`, 'rmbx_a', { campaignId: 'rcmp_a', enrollmentId: 'renr_failing', stepId: 'rcmp_a_s0', status: 'failed', sentAt: null });
      }
      await sent('rmsg_flight', 'rmbx_a', { campaignId: 'rcmp_a', enrollmentId: 'renr_inflight', stepId: 'rcmp_a_s0', status: 'sending', sentAt: null, createdAt: at(-MINUTE) });
      await sent('rmsg_stuck', 'rmbx_a', { status: 'sending', sentAt: null, createdAt: at(-20 * MINUTE) });
    },
  },
  {
    name: 'a refused recipient is a hard bounce that pauses the mailbox and the campaign',
    answers: { 'jane@bigco.io': REFUSED('rcpt', '550 5.1.1 No such user', { recipientRejected: true, code: 550 }) },
    async seed() {
      await mailbox('rmbx_a');
      await campaign({ id: 'rcmp_a', mailboxIds: ['rmbx_a'] });
      await prospect('rpro_jane', { email: 'jane@bigco.io' });
      await enrollment('renr_1', 'rcmp_a', 'rpro_jane');
      // Four bounces in the last day, and a history of sends with one bounce in it.
      for (let i = 0; i < 24; i++) {
        await prospect(`rpro_old${i}`);
        const bounced = i < 4;
        await enrollment(`renr_old${i}`, 'rcmp_a', `rpro_old${i}`, {
          status: bounced ? 'bounced' : 'completed',
          mailboxId: 'rmbx_a',
          nextSendAt: null,
          updatedAt: at(-HOUR),
        });
        await sent(`rmsg_old${i}`, 'rmbx_a', {
          campaignId: 'rcmp_a',
          enrollmentId: `renr_old${i}`,
          stepId: 'rcmp_a_s0',
          createdAt: at(-30 * HOUR + i * MINUTE),
          sentAt: at(-30 * HOUR + i * MINUTE),
          status: bounced ? 'failed' : 'sent',
        });
      }
    },
  },
  {
    name: 'login, temporary and uncertain failures',
    answers: {
      'auth@bigco.io': REFUSED('auth', '535 5.7.8 Bad credentials', { authFailed: true, code: 535 }),
      'later@bigco.io': REFUSED('data', '451 4.3.0 Try again later', { permanent: false }),
      'maybe@bigco.io': REFUSED('data', 'timed out after DATA', { permanent: false, deliveryUncertain: true }),
      'rejected@bigco.io': REFUSED('data', '554 5.7.1 Message rejected'),
      'throws@bigco.io': 'throw',
    },
    async seed() {
      for (const m of ['rmbx_auth', 'rmbx_later', 'rmbx_maybe', 'rmbx_rejected', 'rmbx_throws']) await mailbox(m);
      await mailbox('rmbx_nologin', { smtpCredentials: null });
      await campaign({
        id: 'rcmp_a',
        mailboxIds: ['rmbx_auth', 'rmbx_later', 'rmbx_maybe', 'rmbx_rejected', 'rmbx_throws', 'rmbx_nologin'],
        steps: [{ subject: 'Hi', body: 'One' }, { subject: 'Again', body: 'Two' }],
      });
      for (const p of ['auth', 'later', 'maybe', 'rejected', 'throws', 'nologin']) {
        await prospect(`rpro_${p}`, { email: `${p}@bigco.io` });
        await enrollment(`renr_${p}`, 'rcmp_a', `rpro_${p}`, { mailboxId: `rmbx_${p}` });
      }
    },
  },
  {
    name: 'nothing active, nothing due',
    async seed() {
      await mailbox('rmbx_a');
      await campaign({ id: 'rcmp_draft', mailboxIds: ['rmbx_a'], campaign: { status: 'draft' } });
      await campaign({ id: 'rcmp_later', mailboxIds: ['rmbx_a'] });
      await prospect('rpro_1');
      await prospect('rpro_2');
      await enrollment('renr_1', 'rcmp_draft', 'rpro_1');
      await enrollment('renr_2', 'rcmp_later', 'rpro_2', { nextSendAt: at(2 * HOUR) });
    },
  },
];

/** Every reach row the tick may touch, as Drizzle reads them. */
async function snapshot(): Promise<Record<string, unknown[]>> {
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const messages = await db.select().from(reachMessages);
  messages.sort((a, b) => {
    const ka = `${a.enrollmentId ?? ''}|${a.stepId ?? ''}|${GENERATED_ID.test(a.id) ? '~' : a.id}`;
    const kb = `${b.enrollmentId ?? ''}|${b.stepId ?? ''}|${GENERATED_ID.test(b.id) ? '~' : b.id}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const suppressions = await db.select().from(reachSuppressions);
  suppressions.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  return {
    reach_campaigns: (await db.select().from(reachCampaigns)).sort(byId),
    reach_enrollments: (await db.select().from(reachEnrollments)).sort(byId),
    reach_mailboxes: (await db.select().from(reachMailboxes)).sort(byId),
    reach_messages: messages,
    reach_suppressions: suppressions,
  };
}

/** The seeded rows as Postgres has them (`to_jsonb`), for the Rust side to insert. */
async function rawSeed(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of [
    'reach_settings',
    'reach_mailboxes',
    'reach_campaigns',
    'reach_campaign_steps',
    'reach_campaign_mailboxes',
    'reach_prospects',
    'reach_enrollments',
    'reach_messages',
    'reach_suppressions',
  ]) {
    const result = await db.execute(sql.raw(`select to_jsonb(t) as row from ${table} t order by t.id`));
    const rows = (result as unknown as { rows: Array<{ row: unknown }> }).rows;
    out[table] = rows.map((r) => r.row);
  }
  return out;
}

async function runScenario(s: Scenario) {
  await resetReach(db);
  await seedSettings(db, { id: 'rset_1' });
  await s.seed();
  const seed = await rawSeed();
  smtp.answers = s.answers ?? {};
  smtp.calls.length = 0;
  const env = testEnv();
  const now = s.now ?? T0;
  const result = await runSendTick({ env, db, clerkOrgId: 'org_test', limits: resolveWeldReachLimits(s.limits ?? {}), now: () => now });
  const events = (env.events.sent as Array<{ eventType: string; entityId: string; data: unknown }>)
    .map((e) => ({ event: e.eventType, entityId: e.entityId, data: e.data }))
    .sort((a, b) => (`${a.event}|${a.entityId}` < `${b.event}|${b.entityId}` ? -1 : 1));
  const sends = [...smtp.calls].sort((a, b) => (a.to[0]! < b.to[0]! ? -1 : 1));
  const p = new Placeholders();
  const expected = p.json({ result, rows: await snapshot(), events, smtp: sends }) as Record<string, Json>;
  return { name: s.name, now: now.toISOString(), limits: s.limits ?? {}, answers: s.answers ?? {}, seed, expected };
}

// ---------------------------------------------------------------------------
// The pure rules
// ---------------------------------------------------------------------------

function pureCases() {
  const schedule = { timezone: 'Europe/Amsterdam', sendDays: [1, 2, 3, 4, 5], windowStart: '09:00', windowEnd: '17:00' };
  const mailboxes: PlanMailbox[] = [
    { id: 'rmbx_a', status: 'active', dailyCap: 30, rampCurrent: 10, lastSentAt: at(-30 * MINUTE), sentToday: 4 },
    { id: 'rmbx_b', status: 'active', dailyCap: 30, rampCurrent: 30, lastSentAt: at(-5 * MINUTE), sentToday: 0 },
    { id: 'rmbx_c', status: 'active', dailyCap: 2, rampCurrent: 30, lastSentAt: null, sentToday: 2 },
    { id: 'rmbx_d', status: 'paused', dailyCap: 30, rampCurrent: 30, lastSentAt: null, sentToday: 0 },
    { id: 'rmbx_e', status: 'active', dailyCap: 30, rampCurrent: 30, lastSentAt: null, sentToday: 0 },
  ];
  const campaigns: PlanCampaign[] = [
    { id: 'rcmp_a', schedule, dailyLimit: 50, minGapMinutes: 8, sentToday: 3, mailboxIds: ['rmbx_a', 'rmbx_b', 'rmbx_e'] },
    { id: 'rcmp_b', schedule: { ...schedule, timezone: 'UTC' }, dailyLimit: 1, minGapMinutes: 20, sentToday: 1, mailboxIds: ['rmbx_c'] },
    { id: 'rcmp_c', schedule, dailyLimit: 10, minGapMinutes: 4, sentToday: 0, mailboxIds: ['rmbx_d', 'rmbx_c'] },
  ];
  const ctx = (overrides: Partial<PlanContext> = {}): PlanContext => ({
    now: T0,
    dayTimezone: 'Europe/Amsterdam',
    maxDailySends: 300,
    workspaceSentToday: 10,
    ...overrides,
  });
  const p = new Placeholders();
  const jitter = ['rmbx_a:1760263200000', 'x', '', 'rmbx_ü:1', 'a'.repeat(40)].map((seed) => ({ seed, value: jitterFraction(seed) }));
  const gaps = mailboxes.map((m) => ({ id: m.id, capacity: mailboxCapacity(m), gapEndsAt: gapEndsAt(m, 8) }));
  const gates = [ctx(), ctx({ workspaceSentToday: 300 }), ctx({ now: at(9 * HOUR) }), ctx({ now: at(-3 * HOUR) })].flatMap((c) =>
    campaigns.map((campaign) => ({ campaign: campaign.id, now: c.now, workspaceSentToday: c.workspaceSentToday, gate: evaluateCampaignGate(campaign, c) })),
  );
  const readiness = assessMailboxes(mailboxes, campaigns.slice(0, 2), T0);
  const claimed = [
    { id: 'renr_1', campaignId: 'rcmp_a', mailboxId: null },
    { id: 'renr_2', campaignId: 'rcmp_a', mailboxId: null },
    { id: 'renr_3', campaignId: 'rcmp_a', mailboxId: 'rmbx_b' },
    { id: 'renr_4', campaignId: 'rcmp_b', mailboxId: 'rmbx_c' },
    { id: 'renr_5', campaignId: 'rcmp_c', mailboxId: null },
    { id: 'renr_6', campaignId: 'rcmp_gone', mailboxId: null },
    { id: 'renr_7', campaignId: 'rcmp_a', mailboxId: 'rmbx_d' },
    { id: 'renr_8', campaignId: 'rcmp_a', mailboxId: null },
  ];
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  const mailboxMap = new Map(mailboxes.map((m) => [m.id, m]));
  const plans = [ctx(), ctx({ workspaceSentToday: 299 }), ctx({ maxDailySends: 0 })].map((c) => ({
    workspaceSentToday: c.workspaceSentToday,
    maxDailySends: c.maxDailySends,
    plan: planSends(c, byId, mailboxMap, claimed),
  }));
  const nextSteps = [
    { sentAt: T0, delayDays: 3, delayHours: 0 },
    { sentAt: at(5 * HOUR), delayDays: 0, delayHours: 4 },
    { sentAt: at(4 * 24 * HOUR), delayDays: 1, delayHours: 2 },
  ].map((n) => ({ ...n, dueAt: nextStepDueAt(n.sentAt, n, schedule) }));
  return p.json({
    mailboxes,
    campaigns,
    jitter,
    gaps,
    gates,
    readiness: {
      ready: [...readiness.readyMailboxIds].sort(),
      gapBlockedUntil: readiness.gapBlockedUntil,
      unusable: [...readiness.unusableMailboxIds].sort(),
      capped: [...readiness.cappedMailboxIds].sort(),
    },
    claimed,
    plans,
    schedule,
    nextSteps,
  });
}

// ---------------------------------------------------------------------------

function writeOrCheck(name: string, value: unknown): void {
  const file = path.join(OUT_DIR, `${name}.json`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (WRITE) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(file, text);
    return;
  }
  if (!existsSync(file)) return;
  const stored = JSON.parse(readFileSync(file, 'utf8')) as { scenarios?: Array<{ expected: unknown; name: string }> };
  const fresh = JSON.parse(text) as typeof stored;
  // Seeds carry sealed logins (a fresh IV per run): compare what the code did.
  if (stored.scenarios && fresh.scenarios) {
    expect(fresh.scenarios.map((s) => [s.name, s.expected])).toEqual(stored.scenarios.map((s) => [s.name, s.expected]));
  } else {
    expect(fresh).toEqual(stored);
  }
}

describe('Rust parity fixtures (pnpm rust:reach-engine-fixtures)', () => {
  it('the scheduler rules', () => {
    writeOrCheck('send_scheduler', pureCases());
  });

  it('whole send ticks', async () => {
    const scenarios = [];
    for (const s of SCENARIOS) scenarios.push(await runScenario(s));
    expect(scenarios.every((s) => s.expected.result !== null)).toBe(true);
    writeOrCheck('send_ticks', { tickNow: T0.toISOString(), scenarios });
  }, 120_000);
});
