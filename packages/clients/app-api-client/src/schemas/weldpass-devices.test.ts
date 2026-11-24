import { describe, expect, it } from 'vitest';

import {
  deviceEventsSchema,
  MAX_SYNC_VAULTS,
  registerDeviceSchema,
  syncDeviceSchema,
  weldpassSyncResultSchema,
} from './weldpass-devices';

describe('WeldPass device schemas (PASS-010)', () => {
  it('registers a phone by name and platform', () => {
    expect(registerDeviceSchema.parse({ name: '  Gert’s iPhone ', platform: 'ios' })).toEqual({
      name: 'Gert’s iPhone',
      platform: 'ios',
    });
    expect(registerDeviceSchema.safeParse({ name: '', platform: 'ios' }).success).toBe(false);
    expect(registerDeviceSchema.safeParse({ name: 'x', platform: 'windows' }).success).toBe(false);
  });

  it('syncs with a cursor per vault, none for a first sync, at most 500 vaults', () => {
    expect(syncDeviceSchema.parse({})).toEqual({ cursors: {} });
    expect(syncDeviceSchema.parse({ cursors: { v1: '2026-11-24T12:00:00.000Z' } }).cursors.v1).toBe(
      '2026-11-24T12:00:00.000Z',
    );
    expect(syncDeviceSchema.safeParse({ cursors: { v1: '' } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: MAX_SYNC_VAULTS + 1 }, (_, i) => [`v${i}`, 'c']));
    expect(syncDeviceSchema.safeParse({ cursors: many }).success).toBe(false);
  });

  it('uploads 1 to 500 offline events with a known action and a time', () => {
    const event = { vaultId: 'v1', itemId: 'i1', action: 'copied', at: '2026-11-24T10:00:00.000Z' };
    expect(deviceEventsSchema.safeParse({ events: [event] }).success).toBe(true);
    expect(deviceEventsSchema.safeParse({ events: [] }).success).toBe(false);
    expect(deviceEventsSchema.safeParse({ events: [{ ...event, action: 'exported' }] }).success).toBe(false);
    expect(deviceEventsSchema.safeParse({ events: [{ ...event, at: 'yesterday' }] }).success).toBe(false);
  });

  it('reads a wipe and a sync with a shared login whose seed stayed on the server', () => {
    expect(
      weldpassSyncResultSchema.parse({
        wipe: true,
        reason: 'revoked',
        syncedAt: '2026-11-24T12:00:00.000Z',
        vaults: [],
        removedVaultIds: [],
      }).wipe,
    ).toBe(true);

    const vault = {
      id: 'v1',
      kind: 'shared',
      ownerId: null,
      name: 'Team',
      description: null,
      createdBy: 'u1',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      role: 'viewer',
    };
    const item = {
      id: 'i1',
      vaultId: 'v1',
      type: 'login',
      title: 'GitHub',
      subtitle: 'me',
      url: 'https://github.com',
      host: 'github.com',
      hasTotp: true,
      passwordChangedAt: null,
      version: 2,
      createdBy: 'u1',
      updatedBy: 'u1',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
      fields: { username: 'me', password: 'pw', totp: '', notes: '' },
    };
    const parsed = weldpassSyncResultSchema.parse({
      wipe: false,
      reason: null,
      syncedAt: '2026-11-24T12:00:00.000Z',
      vaults: [{ vault, cursor: '2026-11-24T11:59:00.000Z', full: true, items: [item], deletedIds: [] }],
      removedVaultIds: ['v9'],
    });
    expect(parsed.vaults[0]?.items[0]?.hasTotp).toBe(true);
  });
});
