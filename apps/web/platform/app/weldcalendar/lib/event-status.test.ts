import { describe, expect, it } from 'vitest';
import {
  eventStatusKind,
  statusDotStyle,
  statusRowClass,
  statusSurfaceClass,
  statusSurfaceStyle,
  statusTitleClass,
} from './event-status';

describe('eventStatusKind', () => {
  it('recognises the three statuses', () => {
    expect(eventStatusKind({ status: 'confirmed' })).toBe('confirmed');
    expect(eventStatusKind({ status: 'tentative' })).toBe('tentative');
    expect(eventStatusKind({ status: 'cancelled' })).toBe('cancelled');
  });

  it('accepts the US spelling and any casing', () => {
    expect(eventStatusKind({ status: 'Canceled' })).toBe('cancelled');
    expect(eventStatusKind({ status: 'TENTATIVE' })).toBe('tentative');
  });

  it('treats a missing or unknown status as confirmed', () => {
    expect(eventStatusKind({})).toBe('confirmed');
    expect(eventStatusKind({ status: null })).toBe('confirmed');
    expect(eventStatusKind({ status: 'something' })).toBe('confirmed');
  });
});

describe('status styling', () => {
  it('leaves confirmed events untouched', () => {
    expect(statusSurfaceClass('confirmed')).toBe('');
    expect(statusSurfaceStyle('confirmed')).toBeUndefined();
    expect(statusTitleClass('confirmed')).toBe('');
    expect(statusRowClass('confirmed')).toBe('');
    expect(statusDotStyle('confirmed', '#f00')).toEqual({ backgroundColor: '#f00' });
  });

  it('strikes through and fades a cancelled event', () => {
    expect(statusTitleClass('cancelled')).toBe('line-through');
    expect(statusSurfaceClass('cancelled')).toContain('opacity-');
    expect(statusRowClass('cancelled')).toContain('opacity-');
  });

  it('outlines and stripes a tentative event without striking it through', () => {
    expect(statusSurfaceClass('tentative')).toContain('border-dashed');
    expect(statusSurfaceStyle('tentative')?.backgroundImage).toContain('repeating-linear-gradient');
    expect(statusTitleClass('tentative')).toBe('');
    expect(statusDotStyle('tentative', '#f00').backgroundColor).toBe('transparent');
  });
});
