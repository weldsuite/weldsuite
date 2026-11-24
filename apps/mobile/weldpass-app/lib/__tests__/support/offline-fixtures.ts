import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { WeldPassSyncedItem, WeldPassSyncResult } from '@weldsuite/app-api-client/domains/weldpass-devices';
import type { WeldPassVault } from '@weldsuite/app-api-client/domains/weldpass-passwords';

import type { AesGcm } from '@/lib/offline/envelope';
import type { KeyValue } from '@/lib/offline/events';

/** AES-256-GCM in Node, in expo-crypto's combined layout: nonce(12) ‖ ciphertext ‖ tag(16). */
export const nodeAes: AesGcm = {
  async seal(plaintext, keyBase64, additionalData) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
    cipher.setAAD(additionalData);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return new Uint8Array(Buffer.concat([iv, ciphertext, cipher.getAuthTag()]));
  },
  async open(combined, keyBase64, additionalData) {
    const iv = combined.subarray(0, 12);
    const tag = combined.subarray(combined.length - 16);
    const ciphertext = combined.subarray(12, combined.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
    decipher.setAAD(additionalData);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  },
};

export const KEY = randomBytes(32).toString('base64');
export const OTHER_KEY = randomBytes(32).toString('base64');

export function memoryStore(): KeyValue & { getAllKeys: () => Promise<string[]>; data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
    getAllKeys: async () => [...data.keys()],
  };
}

export function vault(id: string, kind: 'personal' | 'shared' = 'shared'): WeldPassVault {
  return {
    id,
    kind,
    ownerId: kind === 'personal' ? 'u1' : null,
    name: kind === 'personal' ? 'Personal' : `Vault ${id}`,
    description: null,
    createdBy: 'u1',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    role: 'editor',
  };
}

export function item(id: string, vaultId: string, password = 'pw'): WeldPassSyncedItem {
  return {
    id,
    vaultId,
    type: 'login',
    title: `Item ${id}`,
    subtitle: 'me@example.com',
    url: 'https://example.com',
    host: 'example.com',
    hasTotp: false,
    passwordChangedAt: null,
    version: 1,
    createdBy: 'u1',
    updatedBy: 'u1',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    fields: { username: 'me@example.com', password, totp: '', notes: '' },
  };
}

export function syncResult(
  vaults: { id: string; kind?: 'personal' | 'shared'; full?: boolean; items?: WeldPassSyncedItem[]; deletedIds?: string[]; cursor?: string }[],
  extra: Partial<WeldPassSyncResult> = {},
): WeldPassSyncResult {
  return {
    wipe: false,
    reason: null,
    syncedAt: '2026-11-24T12:00:00.000Z',
    vaults: vaults.map((entry) => ({
      vault: vault(entry.id, entry.kind),
      cursor: entry.cursor ?? '2026-11-24T11:59:00.000Z',
      full: entry.full ?? false,
      items: entry.items ?? [],
      deletedIds: entry.deletedIds ?? [],
    })),
    removedVaultIds: [],
    ...extra,
  };
}
