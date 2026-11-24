/**
 * WeldPass's own native code (local Expo module `weldpass-native`).
 *
 * The sensitive clipboard: a copied password is marked sensitive and leaves
 * the clipboard on its own.
 *   - Android: `android.content.extra.IS_SENSITIVE` on the clip, so the
 *     system's copy preview hides it (Android 13+); cleared after the expiry
 *     by a native timer, which also fires with the app in the background.
 *   - iOS: a local-only pasteboard item (never Universal Clipboard to a Mac)
 *     with an expiration date.
 *
 * `weldPassNative` is null in Expo Go and in a binary built before this
 * module existed: `lib/clipboard.ts` then falls back to expo-clipboard.
 */

import { requireOptionalNativeModule } from 'expo';

export interface WeldPassNativeModule {
  /**
   * Put `text` on the clipboard, marked sensitive, gone after
   * `expiresInSeconds`. Resolves a token that names this copy.
   */
  setSensitiveString(text: string, expiresInSeconds: number): Promise<string>;
  /** Clear the clipboard if it still holds the copy `token` names. */
  clearIfUnchanged(token: string): Promise<boolean>;
}

export const weldPassNative = requireOptionalNativeModule<WeldPassNativeModule>('WeldPassNative');
