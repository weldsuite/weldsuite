import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));

import {
  DayCount,
  errorMessage,
  formatMonth,
  formatWeekdayDate,
  formatWeekdayShort,
  listLoadError,
  setHrFormatLocale,
} from './shared';

describe('listLoadError', () => {
  it('shows no error while the list still has data', () => {
    expect(listLoadError([{ id: 'a' }], new Error('refetch failed'), 'fallback')).toBeNull();
  });

  it('shows no error when nothing failed', () => {
    expect(listLoadError(undefined, null, 'fallback')).toBeNull();
  });

  it('shows the query error message when there is no data', () => {
    const error = listLoadError(undefined, new Error('Boom'), 'fallback');
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe('Boom');
  });

  it('falls back to a readable message for a non-Error failure or an empty message', () => {
    expect(listLoadError(undefined, 'nope', 'Could not load')?.message).toBe('Could not load');
    expect(errorMessage(new Error(''), 'Could not load')).toBe('Could not load');
  });
});

describe('weekday and month formatting', () => {
  beforeEach(() => setHrFormatLocale('en-GB'));
  afterEach(() => setHrFormatLocale(undefined));

  it('formats a calendar day with its weekday', () => {
    expect(formatWeekdayDate('2026-11-24')).toMatch(/^Tue,? 24 Nov 2026$/);
  });

  it('reads an instant for a weekday date', () => {
    expect(formatWeekdayDate('2026-11-24T12:00:00')).toContain('Nov 2026');
  });

  it('shows a dash for an empty weekday date', () => {
    expect(formatWeekdayDate(null)).toBe('—');
    expect(formatWeekdayDate('')).toBe('—');
  });

  it('gives a short weekday name', () => {
    expect(formatWeekdayShort('2026-11-24')).toBe('Tue');
  });

  it('gives the month of a date, a month or an instant', () => {
    expect(formatMonth('2026-11-24')).toBe('November 2026');
    expect(formatMonth('2026-11')).toBe('November 2026');
    expect(formatMonth('2026-11-24T10:00:00')).toBe('November 2026');
  });
});

describe('DayCount', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // A Wednesday.
    vi.setSystemTime(new Date('2026-11-25T10:00:00'));
  });
  afterEach(() => vi.useRealTimers());

  it('shows the plain number of days', () => {
    render(<DayCount days={3} startDate="2026-11-23" endDate="2026-11-25" />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('formats the count with the given formatter', () => {
    render(<DayCount days={2} startDate="2026-11-23" endDate="2026-11-24" format={(d) => `${d}d`} />);
    expect(screen.getByText('2d')).toBeInTheDocument();
  });

  it('says Weekend for a zero-day period that is all Saturday and Sunday', () => {
    render(<DayCount days={0} startDate="2026-11-21" endDate="2026-11-22" />);
    const label = screen.getByText('weldhr.common.weekend');
    expect(label).toHaveAttribute('title', 'weldhr.common.weekendHelp');
  });

  it('keeps a 0 when the zero-day period spans working days', () => {
    render(<DayCount days={0} startDate="2026-11-23" endDate="2026-11-24" />);
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.queryByText('weldhr.common.weekend')).not.toBeInTheDocument();
  });

  it('keeps a 0 when the end is before the start', () => {
    render(<DayCount days={0} startDate="2026-11-24" endDate="2026-11-23" />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('runs an open period to today', () => {
    // Saturday 21st to today (Wednesday) includes working days.
    render(<DayCount days={0} startDate="2026-11-21" endDate={null} />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('treats an open weekend-only period as Weekend when today is on the weekend', () => {
    vi.setSystemTime(new Date('2026-11-22T10:00:00'));
    render(<DayCount days={0} startDate="2026-11-21T00:00:00Z" endDate={null} />);
    expect(screen.getByText('weldhr.common.weekend')).toBeInTheDocument();
  });
});
