import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDurableObjectContext } from '../testing/fakes';
import { PanelSalt } from './panel-salt';

const DAY = 24 * 60 * 60 * 1000;

function create(initial: Record<string, unknown> = {}) {
  const state = fakeDurableObjectContext(initial);
  return { salt: new PanelSalt(state.ctx, {}), ...state };
}

describe('PanelSalt', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('creates a random salt on first use and keeps handing out the same one for the day', async () => {
    const { salt, data } = create();
    const first = await salt.today();
    expect(first.date).toBe('2026-10-27');
    expect(first.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(await salt.today()).toEqual(first);
    expect(data.get('salt:2026-10-27')).toBe(first.salt);
  });

  it('hands out different salts on different days', async () => {
    const { salt } = create();
    const monday = await salt.today();
    vi.setSystemTime(new Date('2026-10-28T00:00:01Z'));
    const tuesday = await salt.today();
    expect(tuesday.date).toBe('2026-10-28');
    expect(tuesday.salt).not.toBe(monday.salt);
  });

  it('gives different instances different salts', async () => {
    expect((await create().salt.today()).salt).not.toBe((await create().salt.today()).salt);
  });

  it('schedules a cleanup a minute past the next UTC midnight', async () => {
    const { salt, alarm } = create();
    await salt.today();
    expect(alarm()).toBe(Date.parse('2026-10-28T00:01:00Z'));
  });

  it('leaves an alarm that is already set alone', async () => {
    const { salt, alarm } = create();
    await salt.today();
    vi.setSystemTime(new Date('2026-10-27T18:00:00Z'));
    await salt.today();
    expect(alarm()).toBe(Date.parse('2026-10-28T00:01:00Z'));
  });

  it('deletes salts older than yesterday and keeps yesterday and today', async () => {
    const { salt, data } = create({
      'salt:2026-10-24': 'old',
      'salt:2026-10-25': 'older-than-yesterday',
      'salt:2026-10-26': 'yesterday',
      'salt:2026-10-27': 'today',
    });
    vi.setSystemTime(new Date('2026-10-27T00:01:00Z'));
    await salt.alarm();
    expect([...data.keys()]).toEqual(['salt:2026-10-26', 'salt:2026-10-27']);
  });

  it('goes on daily while salts remain, and stops when none are left', async () => {
    const { salt, data, alarm } = create({ 'salt:2026-10-27': 'today' });
    vi.setSystemTime(new Date('2026-10-28T00:01:00Z'));
    await salt.alarm();
    expect(alarm()).toBe(Date.parse('2026-10-29T00:01:00Z'));

    vi.setSystemTime(new Date('2026-10-30T00:01:00Z'));
    await salt.alarm();
    expect(data.size).toBe(0);
    // Not rescheduled: still the one set before.
    expect(alarm()).toBe(Date.parse('2026-10-29T00:01:00Z'));
  });

  it('the salt of a deleted day is not recreated for that day', async () => {
    // A salt only ever exists for the day it is asked on, so recomputing an old hash is impossible.
    const { salt } = create({ 'salt:2026-10-25': 'gone-soon' });
    vi.setSystemTime(new Date(Date.parse('2026-10-25T12:00:00Z') + 3 * DAY));
    await salt.alarm();
    const fresh = await salt.today();
    expect(fresh.date).toBe('2026-10-28');
    expect(fresh.salt).not.toBe('gone-soon');
  });
});
