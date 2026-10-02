import { describe, it, expect } from 'vitest';
import { isMeetingPast } from './meeting-lifecycle';

const now = new Date('2026-10-02T12:00:00Z');
const at = (iso: string) => new Date(iso);

describe('isMeetingPast', () => {
  it('never treats an unscheduled meeting as past, so its link stays reusable', () => {
    expect(isMeetingPast({ scheduledStart: null, scheduledEnd: null }, now)).toBe(false);
    expect(isMeetingPast(undefined, now)).toBe(false);
  });

  it('uses the scheduled end when there is one', () => {
    expect(isMeetingPast({ scheduledStart: null, scheduledEnd: at('2026-10-02T11:59:00Z') }, now)).toBe(true);
    expect(isMeetingPast({ scheduledStart: null, scheduledEnd: at('2026-10-02T12:30:00Z') }, now)).toBe(false);
  });

  it('falls back to start + 1h without a scheduled end', () => {
    expect(isMeetingPast({ scheduledStart: at('2026-10-02T10:30:00Z'), scheduledEnd: null }, now)).toBe(true);
    expect(isMeetingPast({ scheduledStart: at('2026-10-02T11:30:00Z'), scheduledEnd: null }, now)).toBe(false);
  });
});
