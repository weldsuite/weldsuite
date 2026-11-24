import { describe, expect, it } from 'vitest';
import type { WeldPassItem } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { decideCapture, PENDING_TTL_MS, SaveQueue, type MemoryStore } from './save-queue';

function memory(): MemoryStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    set: async (key, value) => {
      data.set(key, structuredClone(value));
    },
    remove: async (key) => {
      data.delete(key);
    },
  };
}

const login = {
  origin: 'https://example.com',
  host: 'example.com',
  url: 'https://example.com/login',
  username: 'ada',
  password: 'pw-1',
  kind: 'save' as const,
  item: null,
};

function item(overrides: Partial<WeldPassItem> = {}): WeldPassItem {
  return {
    id: 'item-1',
    vaultId: 'vault-1',
    type: 'login',
    title: 'Example',
    subtitle: 'ada',
    url: 'https://example.com',
    host: 'example.com',
    hasTotp: false,
    passwordChangedAt: null,
    version: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-11-24T00:00:00Z',
    updatedAt: '2026-11-24T00:00:00Z',
    ...overrides,
  };
}

describe('SaveQueue', () => {
  it('keeps a pending login per tab for five minutes, then drops it', async () => {
    const store = memory();
    const now = { value: 1_000_000 };
    const queue = new SaveQueue(store, () => now.value);
    await queue.put(7, login);

    expect(await queue.get(8)).toBeNull();
    expect(await queue.get(7)).toMatchObject({ username: 'ada', password: 'pw-1' });

    now.value += PENDING_TTL_MS + 1;
    expect(await queue.get(7)).toBeNull();
    // Dropped from memory, not just hidden.
    expect([...store.data.keys()].some((key) => key.startsWith('weldpass:pending:'))).toBe(false);
  });

  it('takes a pending login out once it is saved, updated or dismissed', async () => {
    const queue = new SaveQueue(memory());
    await queue.put(1, login);
    expect(await queue.take(1)).toMatchObject({ username: 'ada' });
    expect(await queue.get(1)).toBeNull();
  });

  it('forgets everything about a tab when it closes', async () => {
    const store = memory();
    const queue = new SaveQueue(store);
    await queue.put(3, login);
    await queue.rememberUsername(3, 'example.com', 'ada');
    await queue.recordFill(3, { host: 'example.com', item: { id: 'i', vaultId: 'v', title: 't' }, username: 'ada' }, 'pw');
    await queue.clearTab(3);
    expect([...store.data.keys()].filter((key) => key.endsWith(':3'))).toEqual([]);
  });

  it('records a fill with a salted hash, never the password', async () => {
    const store = memory();
    const queue = new SaveQueue(store);
    await queue.recordFill(2, { host: 'example.com', item: { id: 'i', vaultId: 'v', title: 't' }, username: 'ada' }, 'hunter2');
    const record = await queue.fillRecord(2);
    expect(record?.passwordHash).toBe(await queue.hash('hunter2'));
    expect(record?.passwordHash).not.toBe(await queue.hash('hunter3'));
    expect(JSON.stringify([...store.data.values()])).not.toContain('hunter2');
  });

  it('remembers the username of a first step for the second, on the same host only', async () => {
    const queue = new SaveQueue(memory());
    await queue.rememberUsername(4, 'example.com', 'ada');
    expect(await queue.username(4, 'example.com')).toBe('ada');
    expect(await queue.username(4, 'other.example')).toBeNull();
  });
});

describe('decideCapture', () => {
  const base = { username: 'ada', passwordHash: 'h1', fill: null, host: 'example.com', matches: [] };
  const fill = {
    host: 'example.com',
    item: { id: 'item-1', vaultId: 'vault-1', title: 'Example' },
    username: 'ada',
    passwordHash: 'h1',
    at: 0,
  };

  it('offers to save a login it has never seen', () => {
    expect(decideCapture(base)).toEqual({ action: 'save' });
  });

  it('asks nothing when the submitted login is the one it filled', () => {
    expect(decideCapture({ ...base, fill })).toEqual({ action: 'ignore' });
    // A password-only second step of that login, too.
    expect(decideCapture({ ...base, username: '', fill })).toEqual({ action: 'ignore' });
  });

  it('offers to update a filled login whose password was changed', () => {
    expect(decideCapture({ ...base, passwordHash: 'h2', fill })).toEqual({
      action: 'update',
      item: fill.item,
    });
  });

  it('compares with a saved login of the same username, ignoring case', () => {
    expect(decideCapture({ ...base, username: 'ADA', matches: [item()] })).toEqual({
      action: 'compare',
      item: { id: 'item-1', vaultId: 'vault-1', title: 'Example' },
    });
  });

  it('saves a new username on a site that has other logins', () => {
    expect(decideCapture({ ...base, username: 'grace', matches: [item()] })).toEqual({ action: 'save' });
  });

  it("doesn't guess which login a password-only submit belongs to", () => {
    expect(decideCapture({ ...base, username: '', matches: [item(), item({ id: 'item-2', subtitle: 'grace' })] })).toEqual({
      action: 'ignore',
    });
    expect(decideCapture({ ...base, username: '', matches: [item()] })).toMatchObject({ action: 'compare' });
  });

  it('ignores a fill record of another host', () => {
    expect(decideCapture({ ...base, host: 'other.example', fill })).toEqual({ action: 'save' });
  });
});
