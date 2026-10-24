import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  claimCrossTabNotification,
  isAnyTabInForeground,
  startForegroundTracking,
} from './cross-tab';

describe('claimCrossTabNotification', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('lets only the first claim for a key win', async () => {
    expect(await claimCrossTabNotification('notification:a')).toBe(true);
    expect(await claimCrossTabNotification('notification:a')).toBe(false);
    expect(await claimCrossTabNotification('notification:b')).toBe(true);
  });

  it('respects a claim written by another tab', async () => {
    localStorage.setItem(
      'weldsuite:os-notification-claims',
      JSON.stringify({ 'notification:a': Date.now() + 60_000 }),
    );
    expect(await claimCrossTabNotification('notification:a')).toBe(false);
  });

  it('ignores and prunes expired claims', async () => {
    localStorage.setItem(
      'weldsuite:os-notification-claims',
      JSON.stringify({ 'notification:a': Date.now() - 1, 'notification:old': Date.now() - 1 }),
    );
    expect(await claimCrossTabNotification('notification:a')).toBe(true);
    const claims = JSON.parse(localStorage.getItem('weldsuite:os-notification-claims')!);
    expect(Object.keys(claims)).toEqual(['notification:a']);
  });

  it('treats corrupt storage as no claims', async () => {
    localStorage.setItem('weldsuite:os-notification-claims', '{not json');
    expect(await claimCrossTabNotification('notification:a')).toBe(true);
  });
});

describe('foreground tracking', () => {
  let hasFocus: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  });

  afterEach(() => {
    hasFocus.mockRestore();
  });

  it('is false when no tab is in the foreground', () => {
    expect(isAnyTabInForeground()).toBe(false);
  });

  it('sees another tab that is in the foreground', () => {
    localStorage.setItem(
      'weldsuite:foreground-tab',
      JSON.stringify({ tabId: 'other', at: Date.now() }),
    );
    expect(isAnyTabInForeground()).toBe(true);
  });

  it('ignores a stale record from a tab that died', () => {
    localStorage.setItem(
      'weldsuite:foreground-tab',
      JSON.stringify({ tabId: 'other', at: Date.now() - 60_000 }),
    );
    expect(isAnyTabInForeground()).toBe(false);
  });

  it('publishes this tab while focused and clears it on blur', () => {
    hasFocus.mockReturnValue(true);
    const stop = startForegroundTracking();
    expect(localStorage.getItem('weldsuite:foreground-tab')).not.toBeNull();

    hasFocus.mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    expect(localStorage.getItem('weldsuite:foreground-tab')).toBeNull();
    stop();
  });

  it("doesn't clear a record another tab took over", () => {
    hasFocus.mockReturnValue(true);
    const stop = startForegroundTracking();
    const otherTab = JSON.stringify({ tabId: 'other', at: Date.now() });
    localStorage.setItem('weldsuite:foreground-tab', otherTab);

    hasFocus.mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    expect(localStorage.getItem('weldsuite:foreground-tab')).toBe(otherTab);
    stop();
  });
});
