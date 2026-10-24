import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/desktop', () => ({ getDesktop: () => null, isDesktop: () => false }));
vi.mock('@/lib/utils/notification-sound', () => ({ playMessageReceivedSound: vi.fn() }));

import { showOsNotification } from './desktop-notifications';

const shown: string[] = [];

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  onclick: (() => void) | null = null;
  constructor(title: string) {
    shown.push(title);
  }
  close() {}
}

/** Another tab of the app is in the foreground. */
function otherTabInForeground() {
  localStorage.setItem('weldsuite:foreground-tab', JSON.stringify({ tabId: 'other', at: Date.now() }));
}

describe('showOsNotification across tabs', () => {
  beforeEach(() => {
    shown.length = 0;
    localStorage.clear();
    vi.stubGlobal('Notification', FakeNotification);
    // This tab is in the background.
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows a page-only event while the user works in another tab', async () => {
    otherTabInForeground();

    expect(await showOsNotification({ title: 'New conversation', actionUrl: '/welddesk/inbox/chat/c1' })).toBe(true);
    expect(shown).toEqual(['New conversation']);
  });

  it('skips an every-tab event while the user is looking at the app in another tab', async () => {
    otherTabInForeground();

    expect(
      await showOsNotification({ title: 'Mentioned', dedupeKey: 'notification:n1', skipWhenAnyTabInForeground: true }),
    ).toBe(false);
    expect(shown).toEqual([]);
  });

  it('shows the same notification only once', async () => {
    await showOsNotification({ title: 'Mentioned', dedupeKey: 'notification:n1', skipWhenAnyTabInForeground: true });
    await showOsNotification({ title: 'Mentioned', dedupeKey: 'notification:n1', skipWhenAnyTabInForeground: true });

    expect(shown).toEqual(['Mentioned']);
  });
});
