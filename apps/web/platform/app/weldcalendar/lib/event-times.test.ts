import { describe, it, expect } from 'vitest';
import { normalizeEventTimes } from './event-times';

const at = (iso: string) => new Date(iso);

describe('normalizeEventTimes (timed)', () => {
  it('keeps a valid range untouched', () => {
    const r = normalizeEventTimes(at('2026-10-05T09:00:00'), at('2026-10-05T10:00:00'), false);
    expect(r).toEqual({ ok: true, start: at('2026-10-05T09:00:00'), end: at('2026-10-05T10:00:00') });
  });

  it('rolls a same-day end before the start to the next day (past midnight)', () => {
    const r = normalizeEventTimes(at('2026-10-05T23:00:00'), at('2026-10-05T01:00:00'), false);
    expect(r).toEqual({ ok: true, start: at('2026-10-05T23:00:00'), end: at('2026-10-06T01:00:00') });
  });

  it('rejects an end equal to the start', () => {
    const r = normalizeEventTimes(at('2026-10-05T09:00:00'), at('2026-10-05T09:00:00'), false);
    expect(r).toEqual({ ok: false, error: 'end-before-start' });
  });

  it('rejects an end on an earlier date', () => {
    const r = normalizeEventTimes(at('2026-10-05T09:00:00'), at('2026-10-04T10:00:00'), false);
    expect(r).toEqual({ ok: false, error: 'end-before-start' });
  });

  it('allows a missing end', () => {
    const r = normalizeEventTimes(at('2026-10-05T09:00:00'), null, false);
    expect(r).toEqual({ ok: true, start: at('2026-10-05T09:00:00'), end: null });
  });

  it('treats an invalid end date as no end and an invalid start as an error', () => {
    expect(normalizeEventTimes(at('2026-10-05T09:00:00'), new Date('nope'), false)).toEqual({
      ok: true,
      start: at('2026-10-05T09:00:00'),
      end: null,
    });
    expect(normalizeEventTimes(new Date('nope'), null, false)).toEqual({ ok: false, error: 'invalid-start' });
  });
});

describe('normalizeEventTimes (all day)', () => {
  it('spans whole days and gives a single day a distinct end', () => {
    const r = normalizeEventTimes(at('2026-10-05T14:30:00'), at('2026-10-05T14:30:00'), true);
    expect(r).toEqual({ ok: true, start: at('2026-10-05T00:00:00'), end: at('2026-10-05T23:59:59.999') });
  });

  it('keeps a multi-day range', () => {
    const r = normalizeEventTimes(at('2026-10-05T00:00:00'), at('2026-10-07T00:00:00'), true);
    expect(r).toEqual({ ok: true, start: at('2026-10-05T00:00:00'), end: at('2026-10-07T23:59:59.999') });
  });

  it('rejects an end date before the start date', () => {
    const r = normalizeEventTimes(at('2026-10-05T00:00:00'), at('2026-10-04T00:00:00'), true);
    expect(r).toEqual({ ok: false, error: 'end-before-start' });
  });
});
