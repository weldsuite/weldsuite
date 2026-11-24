/**
 * Copying from WeldPass.
 *
 * `copySecret` (passwords, card numbers, 2FA codes, notes): marked sensitive
 * and cleared after 30 s, through the app's native module
 * (`modules/weldpass-native`): Android's `IS_SENSITIVE` flag with a native
 * clear timer, iOS's local-only pasteboard item with an expiry. Without the
 * native module (Expo Go, an older binary) it falls back to expo-clipboard
 * and a JS timer that clears the clipboard only if it still holds the secret.
 *
 * `copyText` (a username, a website): an ordinary copy, never cleared.
 */

import * as Clipboard from 'expo-clipboard';

import { weldPassNative, type WeldPassNativeModule } from '@/modules/weldpass-native';

export const CLEAR_AFTER_MS = 30_000;

export interface ClipboardBackends {
  native: Pick<WeldPassNativeModule, 'setSensitiveString' | 'clearIfUnchanged'> | null;
  clipboard: Pick<typeof Clipboard, 'setStringAsync' | 'getStringAsync'>;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

const defaultBackends: ClipboardBackends = {
  native: weldPassNative,
  clipboard: Clipboard,
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** The pending clear of the last secret copied; a new copy replaces it. */
let pendingClear: unknown = null;

export async function copySecret(text: string, backends: ClipboardBackends = defaultBackends): Promise<void> {
  if (pendingClear != null) {
    backends.clearTimer(pendingClear);
    pendingClear = null;
  }

  if (backends.native) {
    const native = backends.native;
    const token = await native.setSensitiveString(text, CLEAR_AFTER_MS / 1000);
    // The native side expires the copy itself; this covers a JS timer firing
    // first in the foreground, and is a no-op once the copy is gone.
    pendingClear = backends.setTimer(() => {
      pendingClear = null;
      void native.clearIfUnchanged(token).catch(() => {});
    }, CLEAR_AFTER_MS);
    return;
  }

  await backends.clipboard.setStringAsync(text);
  pendingClear = backends.setTimer(() => {
    pendingClear = null;
    void (async () => {
      // Clear only our own copy, never something copied since.
      if ((await backends.clipboard.getStringAsync()) === text) {
        await backends.clipboard.setStringAsync('');
      }
    })().catch(() => {});
  }, CLEAR_AFTER_MS);
}

export async function copyText(text: string, backends: Pick<ClipboardBackends, 'clipboard'> = defaultBackends): Promise<void> {
  await backends.clipboard.setStringAsync(text);
}

/** Test-only: forget a pending clear. */
export function resetClipboardForTests(): void {
  pendingClear = null;
}
