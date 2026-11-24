import { ApiError, NetworkError } from '@weldsuite/api-client/client';
import type { WeldPassSyncResult } from '@weldsuite/app-api-client/domains/weldpass-devices';

import { findItem } from '@/lib/offline/copy';
import { openCopy } from '@/lib/offline/envelope';
import {
  clearRevoked,
  ensureDevice,
  OfflineUnsupportedError,
  revokedAt,
  revokeThisDevice,
  syncCopy,
  wipeEverything,
  type OfflineDeps,
} from '@/lib/offline/engine';
import { queueEvent, readEvents } from '@/lib/offline/events';

import { item, KEY, memoryStore, nodeAes, syncResult } from './support/offline-fixtures';

const session = { server: 'https://app.weldsuite.eu', userId: 'u1', workspaceId: 'ws_1' };

function setup(answers: (WeldPassSyncResult | Error)[]) {
  const store = memoryStore();
  const files = new Map<string, Uint8Array>();
  const calls: { cursors: Record<string, string>; deviceId: string }[] = [];
  let devices = 0;
  const api = {
    registerDevice: jest.fn(async () => {
      devices += 1;
      return { data: { id: `wpd_${devices}` } };
    }),
    sync: jest.fn(async (deviceId: string, cursors: Record<string, string>) => {
      calls.push({ deviceId, cursors });
      const next = answers.shift();
      if (!next) throw new Error('no more answers');
      if (next instanceof Error) throw next;
      return { data: next };
    }),
    uploadEvents: jest.fn(async () => ({ data: { recorded: 1 } })),
    revokeDevice: jest.fn(async () => undefined),
  };
  const deps = {
    store,
    api,
    aes: nodeAes,
    files: {
      read: (workspace: string) => files.get(workspace) ?? null,
      write: (workspace: string, bytes: Uint8Array) => void files.set(workspace, bytes),
      delete: (workspace: string) => void files.delete(workspace),
      deleteAll: () => files.clear(),
    },
    device: () => ({ name: 'Test phone', platform: 'ios' as const, appVersion: '1.0.0' }),
  } as unknown as OfflineDeps;
  return { deps, store, files, api, calls };
}

describe('syncing the offline copy', () => {
  it('registers once, syncs in full, then sends the cursors it was given', async () => {
    const { deps, files, api, calls } = setup([
      syncResult([{ id: 'v1', full: true, items: [item('i1', 'v1')], cursor: 'c1' }]),
      syncResult([{ id: 'v1', items: [item('i2', 'v1')], cursor: 'c2' }]),
    ]);
    const first = await syncCopy(deps, session, KEY, null);
    expect(first.kind).toBe('synced');
    expect(api.registerDevice).toHaveBeenCalledWith({ name: 'Test phone', platform: 'ios', appVersion: '1.0.0' });
    expect(calls[0]).toEqual({ deviceId: 'wpd_1', cursors: {} });

    // A cold start: the copy comes from the file, sealed with the key.
    const second = await syncCopy(deps, session, KEY, null);
    expect(api.registerDevice).toHaveBeenCalledTimes(1);
    expect(calls[1]).toEqual({ deviceId: 'wpd_1', cursors: { v1: 'c1' } });
    if (second.kind !== 'synced') throw new Error('expected a sync');
    expect(findItem(second.copy, 'v1', 'i1')).not.toBeNull();
    expect(findItem(second.copy, 'v1', 'i2')).not.toBeNull();

    const onDisk = await openCopy(files.get('ws_1')!, KEY, { deviceId: 'wpd_1', workspaceId: 'ws_1' }, nodeAes);
    expect(onDisk.vaults.v1?.cursor).toBe('c2');
  });

  it('uploads what was done offline after a sync, and keeps it when that fails', async () => {
    const { deps, store, api } = setup([syncResult([{ id: 'v1' }]), syncResult([{ id: 'v1' }])]);
    await queueEvent(store, 'ws_1', { vaultId: 'v1', itemId: 'i1', action: 'revealed', at: new Date('2026-11-24T10:00:00Z') });
    api.uploadEvents.mockRejectedValueOnce(new NetworkError());
    await syncCopy(deps, session, KEY, null);
    expect(await readEvents(store, 'ws_1')).toHaveLength(1);

    await syncCopy(deps, session, KEY, null);
    expect(api.uploadEvents).toHaveBeenLastCalledWith('wpd_1', [
      { vaultId: 'v1', itemId: 'i1', action: 'revealed', at: '2026-11-24T10:00:00.000Z' },
    ]);
    expect(await readEvents(store, 'ws_1')).toEqual([]);
  });

  it('wipes on revoke and stays off until turned on again', async () => {
    const { deps, files, api } = setup([
      syncResult([{ id: 'v1', full: true, items: [item('i1', 'v1')] }]),
      syncResult([], { wipe: true, reason: 'revoked' }),
      syncResult([{ id: 'v1', full: true }]),
    ]);
    await syncCopy(deps, session, KEY, null);
    expect(files.has('ws_1')).toBe(true);

    await expect(syncCopy(deps, session, KEY, null)).resolves.toEqual({ kind: 'wiped', reason: 'revoked' });
    expect(files.has('ws_1')).toBe(false);
    expect(await revokedAt(deps, session)).not.toBeNull();

    // No new registration behind the person's back.
    await expect(syncCopy(deps, session, KEY, null)).resolves.toEqual({ kind: 'wiped', reason: 'revoked' });
    expect(api.registerDevice).toHaveBeenCalledTimes(1);

    await clearRevoked(deps, session);
    await expect(syncCopy(deps, session, KEY, null)).resolves.toMatchObject({ kind: 'synced' });
    expect(api.registerDevice).toHaveBeenCalledTimes(2);
  });

  it('keeps the registration when the workspace switches copies off', async () => {
    const { deps, files, api } = setup([
      syncResult([{ id: 'v1', full: true, items: [item('i1', 'v1')] }]),
      syncResult([], { wipe: true, reason: 'disabled' }),
      syncResult([{ id: 'v1', full: true, items: [item('i1', 'v1')] }]),
    ]);
    await syncCopy(deps, session, KEY, null);
    await expect(syncCopy(deps, session, KEY, null)).resolves.toEqual({ kind: 'wiped', reason: 'disabled' });
    expect(files.has('ws_1')).toBe(false);
    await syncCopy(deps, session, KEY, null);
    expect(api.registerDevice).toHaveBeenCalledTimes(1);
  });

  it('registers again, from scratch, when the server no longer knows the device', async () => {
    const { deps, calls } = setup([
      syncResult([{ id: 'v1', full: true, cursor: 'c1' }]),
      new ApiError("device with ID 'wpd_1' not found", 404),
      syncResult([{ id: 'v1', full: true }]),
    ]);
    await syncCopy(deps, session, KEY, null);
    await syncCopy(deps, session, KEY, null);
    expect(calls.map((call) => call.deviceId)).toEqual(['wpd_1', 'wpd_1', 'wpd_2']);
    expect(calls[2]?.cursors).toEqual({});
  });

  it('starts over when the file was sealed with another key', async () => {
    const { deps, files, calls } = setup([
      syncResult([{ id: 'v1', full: true, cursor: 'c1' }]),
      syncResult([{ id: 'v1', full: true }]),
    ]);
    await syncCopy(deps, session, KEY, null);
    expect(files.has('ws_1')).toBe(true);
    await syncCopy(deps, session, Buffer.alloc(32, 7).toString('base64'), null);
    expect(calls[1]?.cursors).toEqual({});
  });

  it('leaves the copy alone when offline', async () => {
    const { deps, files } = setup([syncResult([{ id: 'v1', full: true }]), new NetworkError()]);
    await syncCopy(deps, session, KEY, null);
    const before = files.get('ws_1');
    await expect(syncCopy(deps, session, KEY, null)).rejects.toBeInstanceOf(NetworkError);
    expect(files.get('ws_1')).toBe(before);
  });

  it('tells a server without devices apart', async () => {
    const { deps, api } = setup([]);
    api.registerDevice.mockRejectedValueOnce(new ApiError('Not Found', 404));
    await expect(ensureDevice(deps, session)).rejects.toBeInstanceOf(OfflineUnsupportedError);
  });
});

describe('signing out', () => {
  it('revokes this phone, then nothing of WeldPass stays in storage', async () => {
    const { deps, store, files, api } = setup([syncResult([{ id: 'v1', full: true, items: [item('i1', 'v1')] }])]);
    await syncCopy(deps, session, KEY, null);
    await queueEvent(store, 'ws_1', { vaultId: 'v1', itemId: 'i1', action: 'copied' });
    await store.setItem('weldpass:locale', 'nl');

    await revokeThisDevice(deps, session);
    expect(api.revokeDevice).toHaveBeenCalledWith('wpd_1');
    await wipeEverything(deps);
    expect(files.size).toBe(0);
    expect([...store.data.keys()]).toEqual(['weldpass:locale']);
  });
});
