import { describe, expect, it } from 'vitest';
import { CounterRules } from './counters';
import { memoryFormCounters, memoryStore } from './counters.memory';

const clock = (start = Date.UTC(2026, 10, 9, 12, 0, 0)) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
};

describe('CounterRules', () => {
  it('counts a view once per key and day, and lists views per day', async () => {
    const time = clock();
    const rules = new CounterRules(memoryStore(), time.now);
    expect(await rules.recordView('2026-11-09', 'tab-a')).toBe(true);
    expect(await rules.recordView('2026-11-09', 'tab-a')).toBe(false);
    expect(await rules.recordView('2026-11-09', 'tab-b')).toBe(true);
    time.advance(86_400_000);
    expect(await rules.recordView('2026-11-10', 'tab-a')).toBe(true);
    expect(await rules.viewsByDay('2026-11-01', '2026-11-30')).toEqual({ '2026-11-09': 2, '2026-11-10': 1 });
    expect(await rules.viewsByDay('2026-11-10', '2026-11-10')).toEqual({ '2026-11-10': 1 });
  });

  it('keeps a day of views for 400 days', async () => {
    const time = clock();
    const rules = new CounterRules(memoryStore(), time.now);
    await rules.recordView('2026-11-09', 'tab-a');
    time.advance(400 * 86_400_000);
    await rules.recordView('2027-12-14', 'tab-a');
    expect(Object.keys(await rules.viewsByDay('2026-01-01', '2028-01-01'))).toEqual(['2026-11-09', '2027-12-14']);
    time.advance(86_400_000);
    await rules.recordView('2027-12-15', 'tab-a');
    expect(Object.keys(await rules.viewsByDay('2026-01-01', '2028-01-01'))).toEqual(['2027-12-14', '2027-12-15']);
  });

  it('drops past days\' view markers on the first view of a day, without listing them on every view', async () => {
    const time = clock();
    const store = memoryStore();
    const lists: string[] = [];
    const counted: typeof store = {
      ...store,
      list: (options) => {
        lists.push(options.prefix);
        return store.list(options);
      },
    };
    const rules = new CounterRules(counted, time.now);
    for (let i = 0; i < 20; i++) await rules.recordView('2026-11-09', `tab-${i}`);
    expect(lists.filter((prefix) => prefix.startsWith('vk'))).toEqual(['vk:']);

    time.advance(86_400_000);
    lists.length = 0;
    await rules.recordView('2026-11-10', 'tab-a');
    expect(lists.filter((prefix) => prefix.startsWith('vk'))).toEqual(['vk:2026-11-09:']);
    lists.length = 0;
    for (let i = 0; i < 20; i++) await rules.recordView('2026-11-10', `tab-${i}`);
    expect(lists.filter((prefix) => prefix.startsWith('vk'))).toEqual([]);
    expect([...store.data.keys()].filter((key) => key.startsWith('vk:2026-11-09'))).toEqual([]);
    expect(await rules.recordView('2026-11-10', 'tab-a')).toBe(false);
    expect(await rules.viewsByDay('2026-11-01', '2026-11-30')).toEqual({ '2026-11-09': 20, '2026-11-10': 21 });
  });

  it('picks up markers written before the day index, once', async () => {
    const time = clock();
    const store = memoryStore();
    store.data.set('vk:2026-11-07:old-a', 1);
    store.data.set('vk:2026-11-08:old-b', 1);
    store.data.set('vk:2026-11-09:today', 1);
    const rules = new CounterRules(store, time.now);
    expect(await rules.recordView('2026-11-09', 'today')).toBe(false);
    expect(await rules.recordView('2026-11-09', 'fresh')).toBe(true);
    expect([...store.data.keys()].filter((key) => key.startsWith('vk:')).sort()).toEqual(['vk:2026-11-09:fresh', 'vk:2026-11-09:today']);
    expect(store.data.get('vk-days')).toEqual(['2026-11-09']);
  });

  it('limits hits per fixed window and opens again in the next one', async () => {
    const time = clock(Date.UTC(2026, 10, 9, 12, 0, 10));
    const rules = new CounterRules(memoryStore(), time.now);
    expect(await rules.rateLimit('ip', 2, 60)).toMatchObject({ allowed: true, remaining: 1 });
    expect(await rules.rateLimit('ip', 2, 60)).toMatchObject({ allowed: true, remaining: 0 });
    expect(await rules.rateLimit('ip', 2, 60)).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 50 });
    expect((await rules.rateLimit('other', 2, 60)).allowed).toBe(true);
    time.advance(50_000);
    expect((await rules.rateLimit('ip', 2, 60)).allowed).toBe(true);
  });

  it('locks a scope after five wrong answers for 15 minutes, even for the right one, then forgets', async () => {
    const time = clock();
    const rules = new CounterRules(memoryStore(), time.now);
    for (let i = 1; i <= 4; i++) expect(await rules.attempt('code:a', false)).toEqual({ ok: false, locked: false, attemptsLeft: 5 - i });
    expect(await rules.attempt('code:a', false)).toEqual({ ok: false, locked: true, attemptsLeft: 0 });
    expect(await rules.attempt('code:a', true)).toEqual({ ok: false, locked: true, attemptsLeft: 0 });
    expect(await rules.tries('code:a')).toBe(5);
    expect(await rules.attempt('code:b', true)).toEqual({ ok: true });
    time.advance(15 * 60 * 1000 + 1);
    expect(await rules.tries('code:a')).toBe(0);
    expect(await rules.attempt('code:a', true)).toEqual({ ok: true });
  });

  it('a right answer clears the count', async () => {
    const rules = new CounterRules(memoryStore());
    await rules.attempt('s', false);
    await rules.attempt('s', false);
    expect(await rules.attempt('s', true)).toEqual({ ok: true });
    expect(await rules.tries('s')).toBe(0);
  });

  it('settles parallel attempts one at a time, so the lock cannot be outrun', async () => {
    const ns = memoryFormCounters();
    const counters = ns.get(ns.idFromName('frm_1'));
    const results = await Promise.all(Array.from({ length: 8 }, () => counters.attempt('code:x', false)));
    expect(results.filter((r) => !r.ok && !r.locked)).toHaveLength(4);
    expect(results.filter((r) => !r.ok && r.locked)).toHaveLength(4);
    // One object per form: another form's counters are separate.
    expect(await ns.get(ns.idFromName('frm_2')).tries('code:x')).toBe(0);
  });
});
