/**
 * Switching server clears everything WeldMail keeps per server (offline cache,
 * outbox, realtime cursors, selected account, pins, tray counts) and nothing else.
 */

import { clearServerData, registerServerDataCleaner } from '../clear-server-data';

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getAllKeys: jest.fn(() => Promise.resolve(Array.from(mockStore.keys()))),
  multiRemove: jest.fn((keys: string[]) => {
    keys.forEach((k) => mockStore.delete(k));
    return Promise.resolve();
  }),
}));

const mockOnClearServerData = jest.fn(() => () => {});
jest.mock('@weldsuite/mobile-platform/runtime', () => ({
  onClearServerData: (name: string, cleaner: () => Promise<void>) => mockOnClearServerData(name, cleaner),
}));

describe('clearServerData', () => {
  beforeEach(() => {
    mockStore.clear();
    mockOnClearServerData.mockClear();
  });

  it('removes the per-server mail data and leaves other keys alone', async () => {
    const perServer = [
      'weldmail.cache.org_1.inbox',
      'weldmail.cache.orgId',
      'weldmail.outbox.1.org_1',
      'weldmail.realtime.cursor.org_1',
      '@weldmail_selected_account',
      '@weldmail_handled_notification_id',
      '@weldmail_inbox_unread',
      'weldmail:pinnedMessages',
    ];
    for (const key of perServer) mockStore.set(key, '1');
    mockStore.set('weldsuite:server', '{"kind":"eu"}');
    mockStore.set('theme', 'dark');

    await clearServerData();

    expect([...mockStore.keys()].sort()).toEqual(['theme', 'weldsuite:server']);
  });

  it('registers itself for a server switch', () => {
    registerServerDataCleaner();
    expect(mockOnClearServerData).toHaveBeenCalledWith('weldmail-offline', clearServerData);
  });
});
