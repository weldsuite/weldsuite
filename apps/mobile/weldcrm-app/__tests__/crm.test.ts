import {
  TASK_STATUSES,
  initialsOf,
  isTaskStatus,
  normalizeTaskStatus,
  repeatInput,
  resolveName,
} from '@/lib/crm';
import { formatRelativeTime } from '@/lib/relative-time';
import { en } from '@/lib/i18n/locales/en';
import { nl } from '@/lib/i18n/locales/nl';

describe('resolveName', () => {
  it('prefers the display name, then full name, then first and last, then email', () => {
    expect(resolveName({ displayName: 'Jane D.', firstName: 'Jane' })).toBe('Jane D.');
    expect(resolveName({ fullName: 'Jane Doe' })).toBe('Jane Doe');
    expect(resolveName({ firstName: 'Jane', lastName: 'Doe' })).toBe('Jane Doe');
    expect(resolveName({ name: 'Acme' })).toBe('Acme');
    expect(resolveName({ email: 'jane@acme.com' })).toBe('jane@acme.com');
    expect(resolveName({}, 'Unknown')).toBe('Unknown');
  });
});

describe('initialsOf', () => {
  it('takes up to two letters', () => {
    expect(initialsOf('Jane Doe')).toBe('JD');
    expect(initialsOf('acme')).toBe('A');
    expect(initialsOf('Jan van der Berg')).toBe('JV');
    expect(initialsOf('')).toBe('?');
  });
});

describe('task statuses', () => {
  it('keeps every status the platform uses', () => {
    for (const status of TASK_STATUSES) expect(normalizeTaskStatus(status)).toBe(status);
  });

  it('maps legacy and unknown statuses', () => {
    expect(normalizeTaskStatus('in-progress')).toBe('in_progress');
    expect(normalizeTaskStatus('in_review')).toBe('review');
    expect(normalizeTaskStatus('blocked')).toBe('backlog');
    expect(normalizeTaskStatus(undefined)).toBe('todo');
    expect(normalizeTaskStatus('stage_custom')).toBe('todo');
  });

  it('narrows strings', () => {
    expect(isTaskStatus('done')).toBe(true);
    expect(isTaskStatus('planned')).toBe(false);
  });
});

describe('repeatInput', () => {
  const everyThreeWeeks = { frequency: 'custom' as const, interval: 3, unit: 'weeks' as const };

  it('keeps the stored rule when the frequency is unchanged', () => {
    expect(repeatInput('custom', everyThreeWeeks)).toBe(everyThreeWeeks);
  });

  it('sends just the frequency when it changed', () => {
    expect(repeatInput('weekly', everyThreeWeeks)).toEqual({ frequency: 'weekly' });
    expect(repeatInput('daily')).toEqual({ frequency: 'daily' });
  });

  it('clears the repeat', () => {
    expect(repeatInput(null, everyThreeWeeks)).toBeNull();
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-08-20T12:00:00Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

  it('speaks English and Dutch', () => {
    expect(formatRelativeTime(daysAgo(0), en, 'en-GB', now)).toBe('Today');
    expect(formatRelativeTime(daysAgo(1), nl, 'nl-NL', now)).toBe('Gisteren');
    expect(formatRelativeTime(daysAgo(3), en, 'en-GB', now)).toBe('3 days ago');
    expect(formatRelativeTime(daysAgo(14), nl, 'nl-NL', now)).toBe('2 weken geleden');
    expect(formatRelativeTime(daysAgo(35), en, 'en-GB', now)).toBe('1 month ago');
    expect(formatRelativeTime(daysAgo(90), en, 'en-GB', now)).toBe('3 months ago');
  });

  it('shows a dash for missing or malformed dates', () => {
    expect(formatRelativeTime(undefined, en, 'en-GB', now)).toBe('—');
    expect(formatRelativeTime('nope', en, 'en-GB', now)).toBe('—');
  });
});
