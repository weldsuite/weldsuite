import { describe, expect, it, vi } from 'vitest';
import { keyValueStore, memoryStore, secureStore } from './stores';

function area() {
  const data: Record<string, unknown> = {};
  const storage = {
    get: vi.fn(async (key: string) => (key in data ? { [key]: data[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    }),
    remove: vi.fn(async (key: string) => {
      delete data[key];
    }),
  };
  return { data, storage: storage as unknown as chrome.storage.StorageArea };
}

describe('keyValueStore', () => {
  it('keeps strings, and reads anything else as missing', async () => {
    const { data, storage } = area();
    const store = keyValueStore(storage);
    expect(await store.getItem('a')).toBeNull();
    await store.setItem('a', '1');
    expect(await store.getItem('a')).toBe('1');
    data.b = 42;
    expect(await store.getItem('b')).toBeNull();
    await store.removeItem('a');
    expect(data).toEqual({ b: 42 });
  });
});

describe('secureStore', () => {
  it('is the same area in the shape the session expects', async () => {
    const { data, storage } = area();
    const store = secureStore(storage);
    await store.setItemAsync('refresh', 'token');
    expect(await store.getItemAsync('refresh')).toBe('token');
    await store.deleteItemAsync('refresh');
    expect(data).toEqual({});
  });
});

describe('memoryStore', () => {
  it('keeps structured values', async () => {
    const { data, storage } = area();
    const store = memoryStore(storage);
    await store.set('weldpass:menu:x', { tabId: 1 });
    expect(await store.get<{ tabId: number }>('weldpass:menu:x')).toEqual({ tabId: 1 });
    expect(await store.get('missing')).toBeUndefined();
    await store.remove('weldpass:menu:x');
    expect(data).toEqual({});
  });
});
