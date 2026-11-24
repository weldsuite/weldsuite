import { applySync, belongsTo, cursorsOf, emptyCopy, findItem, itemsOf, vaultsOf } from '@/lib/offline/copy';
import { CopyFormatError, openCopy, sealCopy } from '@/lib/offline/envelope';

import { item, KEY, nodeAes, OTHER_KEY, syncResult } from './support/offline-fixtures';

const owner = { server: 'https://app.weldsuite.eu', userId: 'u1', workspaceId: 'ws_1', deviceId: 'wpd_1' };

function synced(result: ReturnType<typeof syncResult>, from = emptyCopy(owner)) {
  const outcome = applySync(from, result);
  if (outcome.kind !== 'updated') throw new Error('expected an update');
  return outcome;
}

describe('applying a sync to the copy', () => {
  it('fills an empty copy and hands out the cursors to send next time', () => {
    const { copy, changed } = synced(
      syncResult([
        { id: 'v1', kind: 'personal', full: true, items: [item('i1', 'v1'), item('i2', 'v1')], cursor: 'c1' },
        { id: 'v2', full: true, items: [item('i3', 'v2')], cursor: 'c2' },
      ]),
    );
    expect(changed).toBe(true);
    expect(cursorsOf(copy)).toEqual({ v1: 'c1', v2: 'c2' });
    expect(copy.syncedAt).toBe('2026-11-24T12:00:00.000Z');
    expect(itemsOf(copy).map((entry) => entry.id).sort()).toEqual(['i1', 'i2', 'i3']);
    expect(vaultsOf(copy).find((entry) => entry.id === 'v1')?.itemCount).toBe(2);
  });

  it('merges changes and deletions since the cursor', () => {
    const first = synced(syncResult([{ id: 'v1', full: true, items: [item('i1', 'v1'), item('i2', 'v1')] }])).copy;
    const { copy } = synced(
      syncResult([{ id: 'v1', items: [item('i1', 'v1', 'new password'), item('i9', 'v1')], deletedIds: ['i2'] }]),
      first,
    );
    expect(findItem(copy, 'v1', 'i1')?.fields).toMatchObject({ password: 'new password' });
    expect(findItem(copy, 'v1', 'i2')).toBeNull();
    expect(findItem(copy, 'v1', 'i9')).not.toBeNull();
  });

  it('replaces a vault the server sends whole', () => {
    const first = synced(syncResult([{ id: 'v1', full: true, items: [item('i1', 'v1'), item('i2', 'v1')] }])).copy;
    const { copy } = synced(syncResult([{ id: 'v1', full: true, items: [item('i3', 'v1')] }]), first);
    expect(itemsOf(copy).map((entry) => entry.id)).toEqual(['i3']);
  });

  it('drops vaults the person can no longer read, named or not', () => {
    const first = synced(
      syncResult([
        { id: 'v1', full: true, items: [item('i1', 'v1')] },
        { id: 'v2', full: true, items: [item('i2', 'v2')] },
        { id: 'v3', full: true, items: [item('i3', 'v3')] },
      ]),
    ).copy;
    const outcome = synced(syncResult([{ id: 'v1' }], { removedVaultIds: ['v2'] }), first);
    expect(Object.keys(outcome.copy.vaults)).toEqual(['v1']);
    expect(outcome.removedVaultIds.sort()).toEqual(['v2', 'v3']);
    expect(findItem(outcome.copy, 'v2', 'i2')).toBeNull();
  });

  it('reports no change when nothing moved', () => {
    const first = synced(syncResult([{ id: 'v1', full: true, items: [item('i1', 'v1')] }])).copy;
    expect(synced(syncResult([{ id: 'v1' }]), first).changed).toBe(false);
  });

  it('says to wipe when the device was revoked or copies are off', () => {
    expect(applySync(emptyCopy(owner), syncResult([], { wipe: true, reason: 'revoked' }))).toEqual({
      kind: 'wiped',
      reason: 'revoked',
    });
  });

  it('lists items without their fields', () => {
    const { copy } = synced(syncResult([{ id: 'v1', full: true, items: [item('i1', 'v1')] }]));
    expect(itemsOf(copy)[0]).not.toHaveProperty('fields');
  });

  it('is only read for the server, person, workspace and device it was made for', () => {
    const copy = emptyCopy(owner);
    expect(belongsTo(copy, owner)).toBe(true);
    expect(belongsTo(copy, { ...owner, userId: 'u2' })).toBe(false);
    expect(belongsTo(copy, { ...owner, server: 'https://weld.example.com' })).toBe(false);
    expect(belongsTo(copy, { ...owner, deviceId: 'wpd_2' })).toBe(false);
  });
});

describe('the copy at rest', () => {
  it('round-trips through AES-256-GCM in the layout CryptoKit and javax.crypto read', async () => {
    const { copy } = synced(syncResult([{ id: 'v1', full: true, items: [item('i1', 'v1', 'hunter2')] }]));
    const file = await sealCopy(copy, KEY, nodeAes);
    expect(Array.from(file.subarray(0, 4))).toEqual([0x57, 0x50, 0x4f, 0x31]);
    expect(Buffer.from(file).toString('latin1')).not.toContain('hunter2');
    await expect(openCopy(file, KEY, owner, nodeAes)).resolves.toEqual(copy);
  });

  it("doesn't open with another key, for another device or workspace, or when changed", async () => {
    const file = await sealCopy(emptyCopy(owner), KEY, nodeAes);
    await expect(openCopy(file, OTHER_KEY, owner, nodeAes)).rejects.toThrow();
    await expect(openCopy(file, KEY, { ...owner, deviceId: 'wpd_2' }, nodeAes)).rejects.toThrow();
    await expect(openCopy(file, KEY, { ...owner, workspaceId: 'ws_2' }, nodeAes)).rejects.toThrow();
    const tampered = new Uint8Array(file);
    tampered[tampered.length - 20] ^= 1;
    await expect(openCopy(tampered, KEY, owner, nodeAes)).rejects.toThrow();
    await expect(openCopy(new Uint8Array([1, 2, 3]), KEY, owner, nodeAes)).rejects.toBeInstanceOf(CopyFormatError);
  });
});
