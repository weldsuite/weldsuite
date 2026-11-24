/**
 * `chrome.storage` in the shapes the shared code expects.
 *
 * - `local` (on disk): the refresh token (ADR PASS-009 accepts that it sits
 *   unencrypted there, as in other extensions), the person's name and
 *   workspace list, the chosen server and the settings. Never a password.
 * - `session` (memory only, trusted contexts only): the access token, pending
 *   saves, fill records and open menus.
 */

import type { SecureStoreLike } from '@weldsuite/mobile-platform/oidc-session';
import type { MemoryStore } from './save-queue';

type Area = chrome.storage.StorageArea;

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function keyValueStore(area: Area): KeyValueStore {
  return {
    async getItem(key) {
      const value = (await area.get(key))[key];
      return typeof value === 'string' ? value : null;
    },
    async setItem(key, value) {
      await area.set({ [key]: value });
    },
    async removeItem(key) {
      await area.remove(key);
    },
  };
}

export function secureStore(area: Area): SecureStoreLike {
  const store = keyValueStore(area);
  return {
    getItemAsync: (key) => store.getItem(key),
    setItemAsync: (key, value) => store.setItem(key, value),
    deleteItemAsync: (key) => store.removeItem(key),
  };
}

export function memoryStore(area: Area): MemoryStore {
  return {
    async get<T>(key: string) {
      return (await area.get(key))[key] as T | undefined;
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
    async remove(key) {
      await area.remove(key);
    },
  };
}
