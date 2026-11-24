import type { File } from 'expo-file-system';

import { emptyCopy, applySync } from '@/lib/offline/copy';
import { collectFills, credentialIdentities } from '@/lib/offline/autofill';
import { readEvents } from '@/lib/offline/events';

import { item, memoryStore, syncResult } from './support/offline-fixtures';

jest.mock('expo', () => ({ requireOptionalNativeModule: () => null }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

const owner = { server: 'https://app.weldsuite.eu', userId: 'u1', workspaceId: 'ws_1', deviceId: 'wpd_1' };

describe('what the system autofill gets', () => {
  it('lists hosts and usernames for QuickType, never a password', () => {
    const outcome = applySync(
      emptyCopy(owner),
      syncResult([
        {
          id: 'v1',
          full: true,
          items: [
            item('i1', 'v1', 'hunter2'),
            { ...item('i2', 'v1'), host: null },
            { ...item('i3', 'v1'), fields: { username: '', password: 'x', totp: '', notes: '' } },
            { ...item('i4', 'v1'), type: 'note', fields: { content: 'secret' } },
          ],
        },
      ]),
    );
    if (outcome.kind !== 'updated') throw new Error('expected an update');
    const identities = credentialIdentities([outcome.copy]);
    expect(identities).toEqual([
      { host: 'example.com', username: 'me@example.com', recordIdentifier: 'ws_1/v1/i1' },
    ]);
    expect(JSON.stringify(identities)).not.toContain('hunter2');
  });

  it('moves the fills the extension queued into the device events, once', async () => {
    const store = memoryStore();
    let content: string | null = JSON.stringify([
      { workspaceId: 'ws_1', vaultId: 'v1', itemId: 'i1', at: '2026-11-24T10:00:00.000Z' },
      { workspaceId: 'ws_2', vaultId: 'v9', itemId: 'i9', at: '2026-11-24T10:05:00.000Z' },
    ]);
    const file = {
      get exists() {
        return content !== null;
      },
      textSync: () => content ?? '',
      delete: () => {
        content = null;
      },
    } as unknown as File;

    await expect(collectFills(file, store)).resolves.toBe(2);
    expect(await readEvents(store, 'ws_1')).toEqual([
      { vaultId: 'v1', itemId: 'i1', action: 'autofilled', at: '2026-11-24T10:00:00.000Z' },
    ]);
    expect(await readEvents(store, 'ws_2')).toHaveLength(1);
    await expect(collectFills(file, store)).resolves.toBe(0);
  });

  it('drops a queue it cannot read', async () => {
    let content: string | null = 'not json';
    const file = {
      get exists() {
        return content !== null;
      },
      textSync: () => content ?? '',
      delete: () => {
        content = null;
      },
    } as unknown as File;
    await expect(collectFills(file, memoryStore())).resolves.toBe(0);
    expect(content).toBeNull();
  });
});
