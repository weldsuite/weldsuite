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
  /**
   * Keep a file or folder (a `file://` URI) out of iCloud and iTunes
   * backups. A no-op on Android, where the app's `allowBackup` is off.
   * Absent in binaries built before the offline copy (1.0 without 4B).
   */
  excludeFromBackup?(uri: string): boolean;

  // Native autofill (phase 4C). Absent in binaries built before it.

  /** iOS: the Keychain group shared with the AutoFill extension (Info.plist), or null. */
  keychainGroup?(): string | null;

  /** iOS: replace the system's QuickType list with these logins (JSON: host, username, recordIdentifier). */
  replaceCredentialIdentities?(json: string): Promise<boolean>;
  /** iOS: empty the system's QuickType list (sign-out, wipe). */
  clearCredentialIdentities?(): Promise<boolean>;
  /** Android: hand the copy's key to the autofill service, wrapped; within 30 s of an unlock. */
  storeAutofillKey?(keyBase64: string): boolean;
  /** Android: forget the autofill service's key (sign-out, wipe). */
  clearAutofillKey?(): void;
  /** Android: a login the autofill service was asked to save, once. */
  takePendingSave?(): { username: string; password: string; webDomain: string | null; packageName: string } | null;
  /** Whether WeldPass is the phone's autofill provider (iOS: AutoFill Passwords on; Android: the selected service). */
  autofillEnabled?(): Promise<boolean>;
  /** Opens the system screen where WeldPass is chosen as the autofill provider. */
  openAutofillSettings?(): void;
}

export const weldPassNative = requireOptionalNativeModule<WeldPassNativeModule>('WeldPassNative');
