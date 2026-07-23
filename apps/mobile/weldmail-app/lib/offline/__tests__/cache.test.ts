/**
 * Unit tests for the offline read-cache. Uses a real in-memory AsyncStorage
 * mock (the global jest.setup stub is a no-op) so read-after-write, org
 * scoping, version busting, and clearOrg can be asserted end-to-end.
 */

// In-memory AsyncStorage that actually persists, supports getAllKeys/multiRemove.
// Prefixed `mock*` so jest allows the mock factory to reference it (hoisting rule).
const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn((k: string) => Promise.resolve(mockStore.has(k) ? mockStore.get(k)! : null)),
  setItem: jest.fn((k: string, v: string) => {
    mockStore.set(k, v);
    return Promise.resolve();
  }),
  removeItem: jest.fn((k: string) => {
    mockStore.delete(k);
    return Promise.resolve();
  }),
  getAllKeys: jest.fn(() => Promise.resolve(Array.from(mockStore.keys()))),
  multiRemove: jest.fn((keys: string[]) => {
    keys.forEach((k) => mockStore.delete(k));
    return Promise.resolve();
  }),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { mailCache, scopeKey, readEntry, writeEntry, clearOrgCache } from '../cache';

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
});

describe('scopeKey', () => {
  it('returns "unified" for the unified inbox', () => {
    expect(scopeKey(true, 'acc_1')).toBe('unified');
    expect(scopeKey(true, null)).toBe('unified');
  });
  it('returns the account id for a specific account', () => {
    expect(scopeKey(false, 'acc_1')).toBe('acc_1');
  });
  it('falls back to "none" when no account id is given', () => {
    expect(scopeKey(false, null)).toBe('none');
    expect(scopeKey(false, undefined)).toBe('none');
  });
});

describe('read/write round-trip', () => {
  it('returns what was written for the same org + key', async () => {
    await writeEntry('org_a', ['messages', 'unified', 'INBOX'], [{ id: 'm1' }]);
    const got = await readEntry<{ id: string }[]>('org_a', ['messages', 'unified', 'INBOX']);
    expect(got).toEqual([{ id: 'm1' }]);
  });

  it('returns null on a miss', async () => {
    expect(await readEntry('org_a', ['messages', 'unified', 'SENT'])).toBeNull();
  });

  it('scopes entries by org — org B cannot read org A', async () => {
    await mailCache.setMessages('org_a', 'unified', 'INBOX', [{ id: 'a' }]);
    expect(await mailCache.getMessages('org_b', 'unified', 'INBOX')).toBeNull();
    expect(await mailCache.getMessages('org_a', 'unified', 'INBOX')).toEqual([{ id: 'a' }]);
  });
});

describe('version busting', () => {
  it('ignores entries written under a different schema version', async () => {
    // Hand-write an envelope with a stale version under the real key shape.
    const key = 'weldmail.cache.org_a.accounts';
    await AsyncStorage.setItem(key, JSON.stringify({ v: 0, t: 1, data: [{ id: 'x' }] }));
    expect(await mailCache.getAccounts('org_a')).toBeNull();
  });

  it('ignores corrupt JSON instead of throwing', async () => {
    await AsyncStorage.setItem('weldmail.cache.org_a.accounts', '{not json');
    expect(await mailCache.getAccounts('org_a')).toBeNull();
  });
});

describe('named accessors', () => {
  it('round-trips accounts, labels, message and thread', async () => {
    await mailCache.setAccounts('o', [{ id: 'acc_1' }]);
    await mailCache.setLabels('o', 'unified', { mainCounts: { INBOX: 3 }, secondaryCounts: {}, custom: [] });
    await mailCache.setMessage('o', 'm1', { id: 'm1', subject: 'hi' });
    await mailCache.setThread('o', 'm1', [{ id: 'm1' }, { id: 'm0' }]);

    expect(await mailCache.getAccounts('o')).toEqual([{ id: 'acc_1' }]);
    expect(await mailCache.getLabels('o', 'unified')).toEqual({ mainCounts: { INBOX: 3 }, secondaryCounts: {}, custom: [] });
    expect(await mailCache.getMessage('o', 'm1')).toEqual({ id: 'm1', subject: 'hi' });
    expect(await mailCache.getThread('o', 'm1')).toHaveLength(2);
  });
});

describe('clearOrgCache', () => {
  it('removes only the target org and leaves others intact', async () => {
    await mailCache.setAccounts('org_a', [{ id: 'a' }]);
    await mailCache.setMessages('org_a', 'unified', 'INBOX', [{ id: 'm' }]);
    await mailCache.setAccounts('org_b', [{ id: 'b' }]);

    await clearOrgCache('org_a');

    expect(await mailCache.getAccounts('org_a')).toBeNull();
    expect(await mailCache.getMessages('org_a', 'unified', 'INBOX')).toBeNull();
    expect(await mailCache.getAccounts('org_b')).toEqual([{ id: 'b' }]);
  });
});
