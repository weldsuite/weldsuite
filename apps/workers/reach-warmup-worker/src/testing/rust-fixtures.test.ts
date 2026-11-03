/**
 * Parity fixtures for the Rust port of the warmup network
 * (`rust/modules/reach/src/warmup_network`), written by this worker's own code.
 *
 * - `builtin_corpus.json` (next to the Rust module): `BUILTIN_CORPUS`, which the
 *   Rust side writes from. There is no AI on the Kubernetes editions, so the
 *   monthly generated set does not exist there.
 * - `tests/fixtures/warmup_pure.json`: business hours and time zones, the day's
 *   plan and send times, pairing, thread picks and rendering, each case drawing
 *   from the same scripted random sequence.
 *
 *   pnpm rust:reach-warmup-fixtures        write them
 *   pnpm --filter reach-warmup-worker test fails when they are stale
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_CORPUS, renderCorpusMessage } from '../corpus';
import { fillPlaceholders } from '../corpus/render';
import { addDays, businessWindow, businessWindowOn, intoBusinessHours, localParts, nextBusinessDate, zonedTimeToUtc } from '../lib/time';
import { shuffled, type Rng } from '../lib/random';
import { dailyTargetFor, newThreadsFor, planDay, spreadTimes } from '../schedule';
import { createPairingState, pickRecipient, pickThreadId, type PairingMailbox } from '../pairing';

const RUST_MODULE = path.resolve(import.meta.dirname, '../../../../../rust/modules/reach');
const WRITE = process.env.WRITE_RUST_FIXTURES === '1';

/** A fixed sequence in [0, 1) (a 32-bit LCG), shared with the Rust test through the fixture. */
const SEQUENCE: number[] = (() => {
  const out: number[] = [];
  let state = 20_261_012;
  for (let i = 0; i < 97; i++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    out.push(state / 4_294_967_296);
  }
  return out;
})();

/** A scripted source that starts at the sequence's beginning and cycles. */
function scripted(): Rng {
  let i = 0;
  return () => SEQUENCE[i++ % SEQUENCE.length]!;
}

const ms = (iso: string) => new Date(iso).getTime();

const ZONES = ['Europe/Amsterdam', 'America/New_York', 'Asia/Kolkata', 'Australia/Sydney', 'UTC', 'Not/AZone', ''];
const INSTANTS = [
  '2026-10-12T07:00:00.000Z',
  '2026-10-12T15:29:59.999Z',
  '2026-10-12T16:31:00.000Z',
  '2026-10-16T21:00:00.000Z',
  '2026-10-17T12:00:00.000Z',
  '2026-10-25T00:30:00.000Z',
  '2026-10-25T01:30:00.000Z',
  '2026-03-29T00:30:00.000Z',
  '2026-03-29T01:30:00.000Z',
  '2026-11-01T05:30:00.000Z',
  '2026-11-01T06:30:00.000Z',
  '2026-12-31T23:59:30.000Z',
  '2027-01-04T03:00:00.000Z',
];
const DATES = ['2026-10-12', '2026-10-16', '2026-10-17', '2026-10-25', '2026-03-29', '2026-11-01', '2026-12-31', '2027-02-28', '2028-02-28'];

function timeCases() {
  const parts = ZONES.flatMap((zone) => INSTANTS.map((at) => ({ zone, at: ms(at), parts: localParts(new Date(at), zone) })));
  const windows = ZONES.flatMap((zone) =>
    INSTANTS.map((at) => {
      const w = businessWindow(new Date(at), zone);
      return { zone, at: ms(at), date: w.date, businessDay: w.businessDay, start: w.start.getTime(), end: w.end.getTime() };
    }),
  );
  const windowsOn = ZONES.flatMap((zone) =>
    DATES.map((date) => {
      const w = businessWindowOn(date, zone);
      return { zone, date, businessDay: w.businessDay, start: w.start.getTime(), end: w.end.getTime() };
    }),
  );
  const zoned = ZONES.flatMap((zone) =>
    DATES.flatMap((date) => [0, 90, 540, 1050, 1439].map((minute) => ({ zone, date, minute, at: zonedTimeToUtc(date, minute, zone).getTime() }))),
  );
  const days = DATES.flatMap((date) => [-1, 1, 3, 30, 366].map((n) => ({ date, n, out: addDays(date, n) })));
  const nextBusiness = DATES.map((date) => ({ date, out: nextBusinessDate(date) }));
  const pushed = ZONES.flatMap((zone) =>
    INSTANTS.map((at) => ({ zone, at: ms(at), out: intoBusinessHours(new Date(at), zone, scripted()).getTime() })),
  );
  return { parts, windows, windowsOn, zoned, days, nextBusiness, pushed };
}

function scheduleCases() {
  const threads = Array.from({ length: 46 }, (_, n) => ({ n, out: newThreadsFor(n) }));
  const targets = [false, true].flatMap((maintaining) =>
    [0, 1, 2, 7, 13, 14, 20].map((rampDay) => {
      const rng = scripted();
      return {
        maintaining,
        rampDay,
        out: [0, 1, 2, 3].map(() => dailyTargetFor(maintaining ? 'maintaining' : 'warming', rampDay, rng)),
      };
    }),
  );
  const plans = ['Europe/Amsterdam', 'America/New_York'].flatMap((zone) =>
    INSTANTS.flatMap((at) =>
      [0, 1, 9, 25].map((target) => {
        const w = businessWindow(new Date(at), zone);
        const plan = planDay(target, w, new Date(at));
        return { zone, at: ms(at), target, count: plan.count, from: plan.from.getTime(), until: plan.until.getTime() };
      }),
    ),
  );
  const spreads = [
    [ms('2026-10-12T07:00:00Z'), ms('2026-10-12T15:30:00Z'), 9],
    [ms('2026-10-12T14:00:00Z'), ms('2026-10-12T15:30:00Z'), 25],
    [ms('2026-10-12T15:29:00Z'), ms('2026-10-12T15:30:00Z'), 3],
    [ms('2026-10-12T07:00:00Z'), ms('2026-10-12T15:30:00Z'), 0],
  ].map(([from, until, count]) => ({
    from,
    until,
    count,
    out: spreadTimes(new Date(from!), new Date(until!), count!, scripted()).map((d) => d.getTime()),
  }));
  const shuffles = [0, 1, 2, 5, 12].map((n) => ({ n, out: shuffled(scripted(), Array.from({ length: n }, (_, i) => i)) }));
  return { threads, targets, plans, spreads, shuffles };
}

const POOL: PairingMailbox[] = [
  { id: 'rwmb_a1', workspaceId: 'ws_a', domain: 'alpha.io', mailboxType: 'shared', capacity: 9 },
  { id: 'rwmb_a2', workspaceId: 'ws_a', domain: 'alpha.io', mailboxType: 'google', capacity: 3 },
  { id: 'rwmb_b1', workspaceId: 'ws_b', domain: 'beta.nl', mailboxType: 'shared', capacity: 9 },
  { id: 'rwmb_b2', workspaceId: 'ws_b', domain: 'beta2.nl', mailboxType: 'google', capacity: 1 },
  { id: 'rwmb_c1', workspaceId: 'ws_c', domain: 'gamma.de', mailboxType: 'shared', capacity: 25 },
  { id: 'rwmb_d1', workspaceId: 'ws_a', domain: 'delta.fr', mailboxType: 'google', capacity: 0 },
];

function pairingCases() {
  const picks = [
    { sender: 'rwmb_a1', count: 12, received: {}, cooling: [] as string[] },
    { sender: 'rwmb_c1', count: 30, received: { rwmb_b2: 3, rwmb_a2: 1 }, cooling: ['rwmb_a1|rwmb_c1'] },
    { sender: 'rwmb_b2', count: 5, received: { rwmb_c1: 40 }, cooling: ['rwmb_b2|rwmb_c1', 'rwmb_a1|rwmb_b2'] },
  ].map((c) => {
    const state = createPairingState(new Map(Object.entries(c.received)), new Set(c.cooling));
    const rng = scripted();
    const sender = POOL.find((m) => m.id === c.sender)!;
    const out = Array.from({ length: c.count }, () => pickRecipient(sender, POOL, state, rng)?.id ?? null);
    const sorted = (m: Map<string, number>) => Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    return {
      ...c,
      out,
      state: { received: sorted(state.received), domainUses: sorted(state.domainUses), cooling: [...state.coolingPairs].sort() },
    };
  });
  const lonely = pickRecipient(POOL[0]!, [POOL[0]!, POOL[1]!], createPairingState(new Map(), new Set()), scripted());
  const ids = ['builtin-001', 'builtin-002', 'builtin-003', 'builtin-004', 'builtin-005'];
  const threads = [
    { used: [] as string[], count: 8 },
    { used: ['builtin-001', 'builtin-003'], count: 6 },
    { used: ids, count: 7 },
  ].map((c) => {
    const rng = scripted();
    const run = new Map<string, number>();
    return { ...c, out: Array.from({ length: c.count }, () => pickThreadId(ids, new Set(c.used), run, rng)) };
  });
  const noThreads = pickThreadId([], new Set(), new Map(), scripted());
  return { pool: POOL, picks, lonely: lonely?.id ?? null, threads, noThreads };
}

function renderCases() {
  const people = [
    [
      { firstName: 'Jane', lastName: 'Doe' },
      { firstName: 'Pieter', lastName: 'de Vries' },
    ],
    [
      { firstName: ' {Sam} ', lastName: '' },
      { firstName: '', lastName: 'X' },
    ],
  ] as const;
  const rendered = BUILTIN_CORPUS.flatMap((thread) =>
    thread.messages.flatMap((_, step) =>
      people.map(([sender, recipient], pair) => ({ thread: thread.id, step, pair, out: renderCorpusMessage(thread, step, sender, recipient) })),
    ),
  );
  const values = { senderFirstName: 'Ann', recipientFirstName: '' };
  const templates = [
    'Hi {{recipientFirstName}}, thanks !\n\n\n\nBest ,\n{{ senderFirstName }}',
    'Hello {{nobody}} and {{senderFirstName}} .',
    'Broken {{senderFirstName and {{ more',
    'Plain text  with  spaces',
    '{{senderFirstName}}}}{{',
  ].map((template) => ({ template, out: fillPlaceholders(template, values) }));
  let outOfRange: string | null = null;
  try {
    renderCorpusMessage(BUILTIN_CORPUS[0]!, 9, people[0][0], people[0][1]);
  } catch (err) {
    outOfRange = (err as Error).message;
  }
  return { people, values, rendered, templates, outOfRange };
}

function writeOrCheck(file: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (WRITE) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return;
  }
  if (!existsSync(file)) return;
  expect(JSON.parse(text)).toEqual(JSON.parse(readFileSync(file, 'utf8')));
}

describe('Rust parity fixtures (pnpm rust:reach-warmup-fixtures)', () => {
  it('the built-in corpus', () => {
    writeOrCheck(path.join(RUST_MODULE, 'src/warmup_network/builtin_corpus.json'), BUILTIN_CORPUS);
  });

  it('the pure rules', () => {
    writeOrCheck(path.join(RUST_MODULE, 'tests/fixtures/warmup_pure.json'), {
      sequence: SEQUENCE,
      time: timeCases(),
      schedule: scheduleCases(),
      pairing: pairingCases(),
      render: renderCases(),
    });
  });
});
