import { describe, expect, it } from 'vitest';
import type { UnbilledCustomer, UnbilledEntry } from '@/lib/api/domains/weldbooks-time-billing';
import {
  dateRange,
  entriesOf,
  groupTimeLines,
  hasUnratedEntries,
  hoursText,
  lineLocale,
  previewTotals,
  type TimedEntry,
} from './time-billing';

/**
 * The same four entries as the server's own `group_lines` tests in
 * `rust/modules/books-sales/src/time_billing.rs`: the preview must read like the invoice will.
 */
function entry(id: string, projectId: string, user: string, date: string, hours: string, rate: string, extra: Partial<UnbilledEntry> = {}): TimedEntry {
  return {
    id,
    date,
    userId: user,
    userName: user.toUpperCase(),
    description: `Work ${id}`,
    activity: id === 'd' ? 'Build' : 'Design',
    hours,
    rate,
    amount: String(Number(hours) * Number(rate)),
    rateSource: 'project',
    projectId,
    projectName: `Project ${projectId}`,
    ...extra,
  };
}

const sample = (): TimedEntry[] => [
  entry('a', 'x', 'ann', '2026-11-24', '4', '100.00'),
  entry('b', 'x', 'bob', '2026-11-25', '4.5', '100.00'),
  entry('c', 'x', 'ann', '2026-11-26', '4', '100.00'),
  entry('d', 'y', 'ann', '2026-11-26', '1', '50.00'),
];

describe('the invoice lines preview, as the server groups them', () => {
  it('makes a line per project: hours times the rate, the dates as a short range', () => {
    const lines = groupTimeLines(sample(), 'project', 'en');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      description: 'Project x · 24–26 Nov · 12.5 h',
      quantity: 12.5,
      unitPrice: 100,
      amount: 1250,
      projectId: 'x',
      entryIds: ['a', 'b', 'c'],
    });
    expect(lines[1]).toMatchObject({ description: 'Project y · 26 Nov · 1 h', projectId: 'y', amount: 50 });
  });

  it('groups per person, per activity and per entry', () => {
    const byPerson = groupTimeLines(sample(), 'person', 'en');
    expect(byPerson).toHaveLength(3);
    expect(byPerson[0]!.description).toBe('Project x · ANN · 24–26 Nov · 8 h');
    expect(byPerson[0]!.entryIds).toEqual(['a', 'c']);

    const byActivity = groupTimeLines(sample(), 'activity', 'en');
    expect(byActivity).toHaveLength(2);
    expect(byActivity[0]!.description).toBe('Project x · Design · 24–26 Nov · 12.5 h');

    const byEntry = groupTimeLines(sample(), 'entry', 'nl');
    expect(byEntry).toHaveLength(4);
    expect(byEntry[1]!.description).toBe('Project x · 25 nov · Work b · 4,5 h');
    expect(byEntry[1]!.quantity).toBe(4.5);
  });

  it('makes another rate another line, because a line has one unit price', () => {
    const entries = sample();
    entries[1] = { ...entries[1]!, rate: '120.00' };
    const lines = groupTimeLines(entries, 'project', 'en');
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.unitPrice === 120 && line.entryIds.join() === 'b')).toBe(true);
  });

  it('keeps a project together, oldest group first inside it, and projects in name order', () => {
    const lines = groupTimeLines(sample(), 'person', 'en');
    expect(lines.map((line) => `${line.projectId}:${line.entryIds.join('')}`)).toEqual(['x:ac', 'x:b', 'y:d']);
  });

  it('reads an entry without a description from its activity, then from who did it', () => {
    const noText = entry('z', 'x', 'eve', '2026-11-24', '2', '10.00', { description: null, activity: null });
    expect(groupTimeLines([noText], 'entry', 'en')[0]!.description).toBe('Project x · 24 Nov · EVE · 2 h');
    const withActivity = { ...noText, activity: 'Review' };
    expect(groupTimeLines([withActivity], 'entry', 'en')[0]!.description).toBe('Project x · 24 Nov · Review · 2 h');
  });

  it('adds the lines up to the hours and the amount before VAT', () => {
    const lines = groupTimeLines(sample(), 'project', 'en');
    expect(previewTotals(lines)).toEqual({ hours: 13.5, amount: 1300 });
    expect(previewTotals([])).toEqual({ hours: 0, amount: 0 });
  });
});

describe('date ranges', () => {
  it('reads short, across months and years too', () => {
    expect(dateRange('2026-11-24', '2026-11-24', 'en')).toBe('24 Nov');
    expect(dateRange('2026-11-24', '2026-11-26', 'en')).toBe('24–26 Nov');
    expect(dateRange('2026-11-28', '2026-12-02', 'nl')).toBe('28 nov – 2 dec');
    expect(dateRange('2025-12-28', '2026-01-02', 'en')).toBe('28 Dec 2025 – 2 Jan 2026');
  });
});

describe('small helpers', () => {
  it('writes hours with two decimals at most, and a comma in Dutch', () => {
    expect(hoursText(12.5, 'en')).toBe('12.5');
    expect(hoursText(1, 'en')).toBe('1');
    expect(hoursText(0.1167, 'nl')).toBe('0,12');
  });

  it('flattens a customer row into entries that know their project', () => {
    const customer: UnbilledCustomer = {
      customer: { contactId: 'prt_1', name: 'Acme' },
      hours: '5',
      amount: '500.00',
      currency: 'EUR',
      projects: [
        { projectId: 'p1', name: 'One', hours: '2', amount: '200.00', entries: [entry('e1', 'p1', 'ann', '2026-11-01', '2', '100.00')] },
        { projectId: 'p2', name: 'Two', hours: '3', amount: '300.00', entries: [entry('e2', 'p2', 'bob', '2026-11-02', '3', '100.00')] },
      ],
    };
    expect(entriesOf(customer).map((e) => [e.id, e.projectId, e.projectName])).toEqual([
      ['e1', 'p1', 'One'],
      ['e2', 'p2', 'Two'],
    ]);
  });

  it('finds entries that will be invoiced at zero for want of a rate', () => {
    expect(hasUnratedEntries(sample())).toBe(false);
    expect(hasUnratedEntries([...sample(), entry('n', 'x', 'ann', '2026-11-27', '1', '0.00', { rateSource: 'none' })])).toBe(true);
  });

  it('writes the lines in Dutch for a Dutch interface and in English otherwise', () => {
    expect(lineLocale('nl')).toBe('nl');
    expect(lineLocale('en')).toBe('en');
    expect(lineLocale('de')).toBe('en');
    expect(lineLocale(undefined)).toBe('en');
  });
});
