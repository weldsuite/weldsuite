/**
 * `crypto.getRandomValues` from expo-crypto. React Native (Hermes) has no Web
 * Crypto, and `generatePassword` (`@weldsuite/app-api-client`) draws every
 * character from it. Imported first in `app/_layout.tsx`, before any screen
 * can call the generator.
 */

import { getRandomValues } from 'expo-crypto';

export function installRandomValues(target: { crypto?: unknown } = globalThis): void {
  const existing = target.crypto as { getRandomValues?: unknown } | undefined;
  if (typeof existing?.getRandomValues === 'function') return;
  target.crypto = {
    ...(existing ?? {}),
    getRandomValues: <T extends ArrayBufferView | null>(array: T): T =>
      getRandomValues(array as unknown as Uint8Array) as unknown as T,
  };
}

installRandomValues();
