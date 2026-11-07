import { describe, expect, it } from 'vitest';
import { makeAssignedIssue, makeReviewRequest } from '@/app/weldmerge/test-fixtures';
import { HOME_WIDGETS, isWidgetEnabled } from '../registry';
import { compactAge, inboxItemHref, mapInboxItem, weldmergeInboxWidget } from './weldmerge-inbox';

describe('weldmerge-inbox widget', () => {
  it('is registered under its module', () => {
    expect(HOME_WIDGETS['weldmerge-inbox']).toBe(weldmergeInboxWidget);
    expect(weldmergeInboxWidget.module).toBe('weldmerge');
    expect(isWidgetEnabled('weldmerge-inbox')).toBe(true);
  });

  it('defaults to ten rows and accepts 5, 10 and 20 only', () => {
    expect(weldmergeInboxWidget.defaultSettings).toEqual({ maxCount: 10 });
    expect(weldmergeInboxWidget.schema.safeParse({ maxCount: 20 }).success).toBe(true);
    expect(weldmergeInboxWidget.schema.safeParse({ maxCount: 7 }).success).toBe(false);
  });

  it('shows a pull request as repository and number, an issue as its key', () => {
    expect(mapInboxItem(makeReviewRequest(), '5m')).toMatchObject({
      kind: 'review_requested',
      title: 'feat(weldflow): tab visibility per project',
      reference: 'weldsuite/weldsuite #1466',
      when: '5m',
    });
    expect(mapInboxItem(makeAssignedIssue(), '1h')).toMatchObject({ kind: 'assigned', reference: 'API-97' });
  });

  it('marks unread items', () => {
    expect(mapInboxItem({ ...makeReviewRequest(), read: false }, 'x')?.unread).toBe(true);
    expect(mapInboxItem({ ...makeReviewRequest(), read: true }, 'x')?.unread).toBe(false);
  });

  it('leaves out an item that is neither a pull request nor an issue', () => {
    expect(mapInboxItem({ ...makeReviewRequest(), pullRequest: null, issue: null }, 'x')).toBeNull();
  });

  it('opens the pull request or the issue', () => {
    expect(inboxItemHref(makeReviewRequest())).toBe('/weldmerge/pull-requests/mpr_1');
    expect(inboxItemHref(makeAssignedIssue())).toBe('/weldmerge/issues/API-97');
  });
});

describe('compactAge', () => {
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' });
  it('uses minutes, then hours, then days', () => {
    expect(compactAge(5, formatter)).toContain('5');
    expect(compactAge(120, formatter)).toContain('2');
    expect(compactAge(60 * 48, formatter)).toContain('2');
    expect(compactAge(5, formatter)).not.toBe(compactAge(120, formatter));
  });
});
