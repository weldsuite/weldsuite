import {
  TASK_STATUSES,
  TASK_TO_ACTIVITY_STATUS,
  activityStatusToTaskStatus,
  initialsOf,
  isTaskStatus,
  resolveName,
} from '@/lib/crm';
import { formatRelativeTime } from '@/lib/relative-time';
import { formatTrend } from '@/lib/trend';
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

describe('task status mapping', () => {
  it('round-trips every app status through crm_activities', () => {
    for (const status of TASK_STATUSES) {
      expect(activityStatusToTaskStatus(TASK_TO_ACTIVITY_STATUS[status])).toBe(status);
    }
  });

  it('maps unknown and cancelled activity statuses sensibly', () => {
    expect(activityStatusToTaskStatus(undefined)).toBe('todo');
    expect(activityStatusToTaskStatus('planned')).toBe('todo');
    expect(activityStatusToTaskStatus('cancelled')).toBe('blocked');
  });

  it('narrows strings', () => {
    expect(isTaskStatus('done')).toBe(true);
    expect(isTaskStatus('planned')).toBe(false);
  });
});

describe('formatTrend', () => {
  it('shows nothing without a real figure', () => {
    expect(formatTrend(undefined)).toBeNull();
    expect(formatTrend(null)).toBeNull();
    expect(formatTrend(Number.NaN)).toBeNull();
  });

  it('signs positive figures and flags negative ones', () => {
    expect(formatTrend(12.4)).toEqual({ label: '+12%', isPositive: true });
    expect(formatTrend(-4)).toEqual({ label: '-4%', isPositive: false });
    expect(formatTrend(0)).toEqual({ label: '0%', isPositive: true });
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
