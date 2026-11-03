/**
 * Parity fixtures for the Rust port of the SLA engine
 * (`rust/crates/desk-domain/src/sla.rs` and `sla_calendar.rs`), written by
 * this TypeScript code itself: business-time arithmetic on calendars in
 * several time zones (DST changes, half-hour offsets, holidays, overnight
 * windows), policy selection, targets, and timeline replays with their
 * summary and scheduling. `rust/crates/desk-domain/tests/sla_parity.rs`
 * runs the Rust code on the same input and compares.
 *
 *   pnpm rust:desk-sla-fixtures             write the fixtures
 *   pnpm --filter @weldsuite/db test        fails when they are stale
 *
 * Every instant is a JavaScript time value (milliseconds); the inputs come
 * from a seeded generator, so the file only changes with the engine.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BusinessHours, HelpdeskSla } from '../schema/helpdesk-slas';
import { addBusinessMs, businessMsBetween, toDeskSlaCalendar } from './desk-sla-calendar';
import {
  deriveDeskSlaClocks,
  deskSlaBusinessHours,
  deskSlaNextCheckAt,
  deskSlaTargets,
  selectDeskSlaPolicy,
  summarizeDeskSla,
  type DeskSlaTimelineEntry,
} from './desk-sla';

const WRITE = process.env.WRITE_RUST_FIXTURES === '1';
const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../rust/crates/desk-domain/tests/fixtures/desk_sla.json',
);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** mulberry32: a small seeded generator, so the inputs are the same every run. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ms = (iso: string) => new Date(iso).getTime();

const weekdays = (open: string, close: string) => ({ isOpen: true, openTime: open, closeTime: close });
const officeWeek = (open = '09:00', close = '17:00') => ({
  monday: weekdays(open, close),
  tuesday: weekdays(open, close),
  wednesday: weekdays(open, close),
  thursday: weekdays(open, close),
  friday: weekdays(open, close),
});

/** Calendars as policies and settings store them (some deliberately odd). */
const CALENDARS: Record<string, unknown> = {
  none: null,
  amsterdam: {
    timezone: 'Europe/Amsterdam',
    ...officeWeek(),
    holidays: [
      { date: '2026-12-25', name: 'Christmas', isRecurring: true },
      { date: '2026-04-06', name: 'Easter Monday' },
      { date: '2027-01-01T00:00:00.000Z', name: 'New year', isRecurring: true },
    ],
  },
  newYorkNights: {
    timezone: 'America/New_York',
    sunday: weekdays('01:00', '04:00'),
    monday: weekdays('22:00', '06:00'),
    saturday: weekdays('00:00', '24:00'),
    wednesday: { isOpen: true },
  },
  kolkata: { timezone: 'Asia/Kolkata', ...officeWeek('9:30', '18:30') },
  lordHowe: {
    timezone: 'Australia/Lord_Howe',
    ...officeWeek('01:00', '03:00'),
    sunday: weekdays('00:30', '04:30'),
  },
  chatham: { timezone: 'Pacific/Chatham', ...officeWeek('08:15', '16:45') },
  stJohns: { timezone: 'America/St_Johns', ...officeWeek('00:00', '02:30'), saturday: weekdays('23:00', '23:59') },
  lowercaseZone: { timezone: 'europe/london', ...officeWeek() },
  unknownZone: { timezone: 'Mars/Olympus', ...officeWeek() },
  offsetZone: { timezone: '+05:30', ...officeWeek() },
  noZone: { ...officeWeek('10:00', '12:00') },
  oddClocks: {
    timezone: 'Europe/Berlin',
    monday: { isOpen: 1, openTime: ' 7:45 ', closeTime: 'late' },
    tuesday: { isOpen: true, openTime: 'early', closeTime: '12:00' },
    wednesday: { isOpen: true, openTime: '25:00', closeTime: '26:00' },
    thursday: { isOpen: true, openTime: '24:00' },
    friday: { isOpen: 'yes', openTime: '13:00', closeTime: '13:00' },
    holidays: [{ date: 'not a date' }, { date: '2026-11-05', isRecurring: 0 }],
  },
  neverOpen: { timezone: 'UTC', monday: { isOpen: false }, tuesday: { isOpen: true, openTime: '10:00', closeTime: '10:00' } },
  sundaysOnly: { timezone: 'Europe/Amsterdam', sunday: weekdays('12:00', '13:00') },
};

/** Start instants around the DST changes of 2026 and the year end. */
const WINDOWS = [
  ['2026-03-06T00:00:00Z', '2026-03-10T00:00:00Z'],
  ['2026-03-27T00:00:00Z', '2026-04-08T00:00:00Z'],
  ['2026-09-25T00:00:00Z', '2026-10-06T00:00:00Z'],
  ['2026-10-23T00:00:00Z', '2026-11-03T00:00:00Z'],
  ['2026-12-22T00:00:00Z', '2027-01-04T00:00:00Z'],
] as const;

function calendarFixtures(): Json {
  const rand = generator(20261031);
  const cases: Json[] = [];
  for (const [name, hours] of Object.entries(CALENDARS)) {
    const calendar = toDeskSlaCalendar(hours as BusinessHours | null);
    const ops: Json[] = [];
    for (const [startIso, endIso] of WINDOWS) {
      const start = ms(startIso);
      const span = ms(endIso) - start;
      for (let i = 0; i < 8; i++) {
        const from = start + Math.floor(rand.next() * span);
        const to = from + rand.pick([0, -MINUTE, MINUTE, 30 * MINUTE, 3 * HOUR, 26 * HOUR, 5 * DAY, 17 * DAY]) +
          rand.int(0, 59) * 1000;
        ops.push({ op: 'between', from, to, result: businessMsBetween(calendar, new Date(from), new Date(to)) });
        const amount = rand.pick([0, -5, 1, 1000, MINUTE, 45 * MINUTE, 2 * HOUR, 8 * HOUR, 30 * HOUR, 100 * HOUR, 1.5, 450_000.25]);
        ops.push({ op: 'add', from, ms: amount, result: addBusinessMs(calendar, new Date(from), amount).getTime() });
      }
    }
    cases.push({ name, hours: hours as Json, isCalendar: calendar !== null, ops });
  }
  return cases;
}

// ── Policies ────────────────────────────────────────────────────────────────

function policy(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'sla_base',
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    isDefault: false,
    isActive: true,
    priority: 0,
    conditions: [],
    firstResponseTime: [{ priority: 'medium', time: 60 }],
    resolutionTime: [{ priority: 'medium', time: 480 }],
    updateTime: [{ priority: 'medium', time: 120 }],
    operationalHours: '24x7',
    businessHours: null,
    reminders: null,
    ...fields,
  };
}

function asSla(row: Record<string, unknown>): HelpdeskSla {
  return {
    ...row,
    createdAt: new Date(row.createdAt as string),
    deletedAt: row.deletedAt ? new Date(row.deletedAt as string) : null,
  } as unknown as HelpdeskSla;
}

const POLICIES = [
  policy({ id: 'default_old', isDefault: true, createdAt: '2025-01-01T00:00:00.000Z' }),
  policy({ id: 'default_new', isDefault: true, priority: -1 }),
  policy({ id: 'inactive', isActive: false }),
  policy({ id: 'deleted', deletedAt: '2026-02-01T00:00:00.000Z' }),
  policy({ id: 'urgent', priority: 1, conditions: [{ field: 'priority', operator: 'equals', value: 'URGENT' }] }),
  policy({ id: 'high_up', priority: 2, conditions: [{ field: 'priority', operator: 'greater_than', value: 'medium' }] }),
  policy({ id: 'below_high', priority: 2, conditions: [{ field: 'priority', operator: 'less_than', value: ['high'] }] }),
  policy({ id: 'vip', priority: 3, conditions: [{ field: 'tags', operator: 'contains', value: 'VIP' }] }),
  policy({ id: 'not_email', priority: 3, conditions: [{ field: 'channel', operator: 'not_equals', value: ['email', 'phone'] }] }),
  policy({ id: 'team', priority: 4, conditions: [{ field: 'team', operator: 'equals', value: 'dep_1' }] }),
  policy({ id: 'ann', priority: 4, conditions: [{ field: 'assignee', operator: 'equals', value: 'user_ann' }] }),
  policy({ id: 'domain', priority: 5, conditions: [{ field: 'email', operator: 'contains', value: '@ACME.' }] }),
  policy({ id: 'type_rank', priority: 5, conditions: [{ field: 'type', operator: 'greater_than', value: '2' }] }),
  policy({ id: 'legacy', priority: 6, conditions: [{ field: 'customerTier', operator: 'equals', value: 'gold' }] }),
  policy({ id: 'odd_op', priority: 6, conditions: [{ field: 'priority', operator: 'matches', value: 'high' }] }),
  policy({
    id: 'two_conditions',
    priority: 7,
    conditions: [
      { field: 'channel', operator: 'equals', value: 'messenger' },
      { field: 'tag', operator: 'equals', value: ['billing', 'refund'] },
    ],
  }),
  policy({ id: 'null_value', priority: 8, conditions: [{ field: 'departmentId', operator: 'equals', value: null }] }),
  policy({ id: 'catch_all', priority: 9 }),
];

const CONVERSATIONS: Record<string, unknown>[] = [
  { priority: null, channel: 'email', ticketTypeId: null, departmentId: null, tags: [], assigneeId: null, email: 'a@b.c' },
  { priority: 'urgent', channel: 'email', ticketTypeId: null, departmentId: null, tags: [], assigneeId: null, email: null },
  { priority: 'critical', channel: 'phone', ticketTypeId: '3', departmentId: 'dep_2', tags: ['x'], assigneeId: null, email: null },
  { priority: 'low', channel: 'email', ticketTypeId: null, departmentId: 'dep_1', tags: [], assigneeId: null, email: null },
  { priority: 'medium', channel: 'messenger', ticketTypeId: null, departmentId: 'dep_9', tags: ['vip'], assigneeId: null, email: null },
  { priority: 'high', channel: 'messenger', ticketTypeId: null, departmentId: 'x', tags: ['Refund'], assigneeId: 'user_ann', email: 'jo@acme.io' },
  { priority: 'high', channel: 'email', ticketTypeId: '7', departmentId: 'x', tags: [], assigneeId: 'user_bob', email: 'jo@ACME.io' },
  { priority: 'weird', channel: 'email', ticketTypeId: 'abc', departmentId: 'x', tags: [], assigneeId: null, email: 'z@q.r' },
];

/** Every prefix of the policy list (minus one each time), so each policy gets its turn to win. */
function selectionFixtures(): Json {
  const cases: Json[] = [];
  for (let drop = 0; drop < POLICIES.length; drop++) {
    const candidates = POLICIES.slice(drop);
    for (const conversation of CONVERSATIONS) {
      const chosen = selectDeskSlaPolicy(candidates.map(asSla), conversation as never);
      cases.push({ drop, conversation: conversation as Json, chosen: chosen?.id ?? null });
    }
  }
  return cases;
}

const MALFORMED = [
  { candidates: [policy({ id: 'bad', conditions: { field: 'priority' } })], throws: true },
  { candidates: [policy({ id: 'bad', conditions: [null] })], throws: true },
  { candidates: [policy({ id: 'bad', isDefault: true, conditions: 'nope' })], throws: false },
  { candidates: [policy({ id: 'good', priority: 0 }), policy({ id: 'bad', priority: 1, conditions: 7 })], throws: false },
  { candidates: [policy({ id: 'bad', firstResponseTime: { priority: 'medium' } })], targets: true },
  { candidates: [policy({ id: 'bad', firstResponseTime: [null] })], targets: true },
  { candidates: [policy({ id: 'bad', reminders: 'soon' })], targets: true },
  { candidates: [policy({ id: 'bad', firstResponseTime: [{ priority: 'medium', time: 60, notifyAt: 50 }] })], targets: true },
  { candidates: [policy({ id: 'ok', firstResponseTime: [7, 'x', { priority: 'medium', time: '30' }] })], targets: true },
];

function malformedFixtures(): Json {
  return MALFORMED.map((entry, index) => {
    const run = () => {
      const chosen = selectDeskSlaPolicy(entry.candidates.map(asSla), CONVERSATIONS[0] as never);
      return entry.targets && chosen ? deskSlaTargets(chosen, null) : (chosen?.id ?? null);
    };
    try {
      return { index, candidates: entry.candidates as Json, targets: Boolean(entry.targets), result: run() as unknown as Json, threw: false };
    } catch {
      return { index, candidates: entry.candidates as Json, targets: Boolean(entry.targets), result: null, threw: true };
    }
  });
}

const TARGET_POLICIES = [
  policy({ id: 'plain' }),
  policy({
    id: 'reminders',
    reminders: [
      { type: 'before_breach', time: 10, recipients: [] },
      { type: 'before_breach', time: '25', recipients: [] },
      { type: 'after_breach', time: 40, recipients: [] },
      { type: 'before_breach', time: -3, recipients: [] },
    ],
  }),
  policy({ id: 'reminder_too_big', reminders: [{ type: 'before_breach', time: 60, recipients: [] }] }),
  policy({ id: 'fractional_reminder', reminders: [{ type: 'before_breach', time: 7.5, recipients: [] }] }),
  policy({
    id: 'shares',
    firstResponseTime: [{ priority: 'medium', time: 45, notifyAt: [50, 90, 0, 100, 120] }],
    resolutionTime: [{ priority: 'medium', time: 7, notifyAt: [33] }],
  }),
  policy({
    id: 'per_priority',
    firstResponseTime: [
      { priority: 'urgent', time: 15 },
      { priority: 'urgent', time: 5 },
      { priority: 'low', time: 0 },
      { priority: 'low', time: 240.6 },
    ],
    updateTime: [],
    resolutionTime: null,
  }),
  policy({ id: 'tiny', firstResponseTime: [{ priority: 'medium', time: 1 }], resolutionTime: [{ priority: 'medium', time: 3 }] }),
  policy({ id: 'string_times', firstResponseTime: [{ priority: 'medium', time: '90' }], resolutionTime: [{ priority: 'medium', time: true }] }),
];

function targetFixtures(): Json {
  const cases: Json[] = [];
  for (const row of TARGET_POLICIES) {
    for (const priority of [null, 'medium', 'urgent', 'low', '']) {
      const targets = deskSlaTargets(asSla(row), priority);
      cases.push({ policy: row as Json, priority, targets: targets as unknown as Json });
    }
  }
  return cases;
}

function hoursFixtures(): Json {
  const own = CALENDARS.amsterdam;
  const workspace = CALENDARS.kolkata;
  const cases: Json[] = [];
  for (const operationalHours of ['24x7', 'custom', 'business', 'other']) {
    for (const businessHours of [null, own]) {
      for (const workspaceHours of [null, workspace]) {
        const row = policy({ operationalHours, businessHours });
        cases.push({
          policy: row as Json,
          workspaceHours: workspaceHours as Json,
          result: deskSlaBusinessHours(asSla(row), workspaceHours as BusinessHours | null) as unknown as Json,
        });
      }
    }
  }
  return cases;
}

// ── Timeline replays ────────────────────────────────────────────────────────

const ENTRY_KINDS: Array<Omit<DeskSlaTimelineEntry, 'at'>> = [
  { kind: 'message', authorType: 'visitor' },
  { kind: 'message', authorType: 'visitor' },
  { kind: 'message', authorType: 'visitor' },
  { kind: 'message', authorType: 'agent' },
  { kind: 'message', authorType: 'agent' },
  { kind: 'message', authorType: 'bot' },
  { kind: 'message', authorType: 'system' },
  { kind: 'note', authorType: 'agent' },
  { kind: 'event', authorType: 'agent', eventType: 'closed' },
  { kind: 'event', authorType: 'agent', eventType: 'reopened' },
  { kind: 'event', authorType: 'system', eventType: 'attributes_changed' },
  { kind: 'event', authorType: 'system', eventType: 'sla_warning' },
  { kind: 'event', authorType: 'agent', eventType: null },
];

const REPLAY_CALENDARS = ['none', 'none', 'amsterdam', 'newYorkNights', 'kolkata', 'lordHowe', 'sundaysOnly'];

function replayFixtures(): Json {
  const rand = generator(729);
  const cases: Json[] = [];
  for (let i = 0; i < 300; i++) {
    const row = rand.pick(TARGET_POLICIES);
    const priority = rand.pick([null, 'medium', 'urgent', 'low']);
    const targets = deskSlaTargets(asSla(row), priority);
    const calendarName = rand.pick(REPLAY_CALENDARS);
    const calendar = toDeskSlaCalendar(CALENDARS[calendarName] as BusinessHours | null);
    const [windowStart] = rand.pick(WINDOWS);
    let at = ms(windowStart) + rand.int(0, 6 * 24 * 60) * MINUTE + rand.int(0, 999);
    const timeline: DeskSlaTimelineEntry[] = [];
    const length = rand.int(1, 9);
    for (let j = 0; j < length; j++) {
      at += rand.pick([0, 1000, 7 * MINUTE, 40 * MINUTE, 2 * HOUR, 9 * HOUR, 3 * DAY]) + rand.int(0, 59_999);
      timeline.push({ at: new Date(at), ...rand.pick(ENTRY_KINDS) });
    }
    const now = at + rand.pick([0, 5 * MINUTE, 46 * MINUTE, 50 * MINUTE, 100 * MINUTE, 3 * HOUR, 2 * DAY]);
    const clocks = deriveDeskSlaClocks({ timeline, targets, calendar, now: new Date(now) });
    const rows = clocks.map((clock) => {
      // Some cycles were already announced.
      const warnedAt = clock.warnAt && rand.next() < 0.3 ? clock.warnAt : null;
      const breachNotifiedAt = clock.breachedAt && rand.next() < 0.3 ? clock.breachedAt : null;
      return { ...clock, warnedAt, breachNotifiedAt };
    });
    cases.push({
      calendar: calendarName,
      targets: targets as unknown as Json,
      timeline: timeline.map((e) => ({ ...e, at: e.at.getTime() })) as unknown as Json,
      now,
      clocks: rows.map((clock) => ({
        metric: clock.metric,
        status: clock.status,
        targetMinutes: clock.targetMinutes,
        warnBeforeMinutes: clock.warnBeforeMinutes,
        startedAt: clock.startedAt.getTime(),
        elapsedSeconds: clock.elapsedSeconds,
        dueAt: clock.dueAt?.getTime() ?? null,
        warnAt: clock.warnAt?.getTime() ?? null,
        breachedAt: clock.breachedAt?.getTime() ?? null,
        completedAt: clock.completedAt?.getTime() ?? null,
        warnedAt: clock.warnedAt?.getTime() ?? null,
        breachNotifiedAt: clock.breachNotifiedAt?.getTime() ?? null,
        nextCheckAt: deskSlaNextCheckAt(clock)?.getTime() ?? null,
      })),
      summary: (() => {
        const summary = summarizeDeskSla(rows, new Date(now));
        return { ...summary, slaDueAt: summary.slaDueAt?.getTime() ?? null };
      })(),
    });
  }
  return cases;
}

function build(): Json {
  return {
    calendars: calendarFixtures(),
    selection: { policies: POLICIES as Json, cases: selectionFixtures() },
    malformed: malformedFixtures(),
    targets: targetFixtures(),
    businessHours: hoursFixtures(),
    replays: replayFixtures(),
  };
}

describe('desk SLA parity fixtures', () => {
  it('match the committed Rust fixtures', () => {
    const value = build();
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (WRITE) {
      writeFileSync(FIXTURE, text);
      return;
    }
    const committed = existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Json) : null;
    expect(value, 'rust/crates/desk-domain/tests/fixtures/desk_sla.json is stale: run pnpm rust:desk-sla-fixtures').toEqual(
      committed,
    );
  });
});
