/**
 * The phone's side of the offline copy: the key in the Keychain / Android
 * Keystore (expo-secure-store), AES-GCM (expo-crypto), the file
 * (expo-file-system). Everything else in `lib/offline` is plain logic.
 *
 * The key is 256 random bits behind biometrics, on this device only:
 * expo-secure-store's `requireAuthentication` (iOS `biometryCurrentSet`,
 * Android Keystore with user authentication, BIOMETRIC_STRONG), and
 * `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`, so it never leaves the phone in a
 * backup or a migration. Re-enrolling Face ID or fingerprints invalidates it;
 * the copy is then synced again from scratch.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

import { weldPassNative } from '@/modules/weldpass-native';

import type { AesGcm } from './envelope';

const KEY_NAME = 'weldpass.offline.key';
const KEY_SERVICE = 'weldpass-offline';

/**
 * iOS: the Keychain group shared with the AutoFill extension, so it can read
 * the key too (null in a build without it: the key stays the app's own).
 */
function accessGroup(): { accessGroup?: string } {
  const group = Platform.OS === 'ios' ? weldPassNative?.keychainGroup?.() : null;
  return group ? { accessGroup: group } : {};
}

function keyOptions(prompt?: string): SecureStore.SecureStoreOptions {
  return {
    keychainService: KEY_SERVICE,
    ...accessGroup(),
    requireAuthentication: true,
    keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
    ...(prompt ? { authenticationPrompt: prompt } : {}),
  };
}

/** Whether this phone can hold a key behind biometrics (enrolled Face ID, Touch ID or a strong fingerprint). */
export function canHoldKey(): boolean {
  if (Platform.OS === 'web') return false;
  try {
    return SecureStore.canUseBiometricAuthentication();
  } catch {
    return false;
  }
}

/**
 * Read the key, which asks for Face ID / the fingerprint. Null when there is
 * none; throws when the person cancels or the key was invalidated.
 */
export async function readKey(prompt: string): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_NAME, keyOptions(prompt));
}

/** A new random key, stored behind biometrics (Android asks for them here). */
export async function createKey(prompt: string): Promise<string> {
  const key = await AESEncryptionKey.generate(256);
  const encoded = await key.encoded('base64');
  await SecureStore.setItemAsync(KEY_NAME, encoded, keyOptions(prompt));
  return encoded;
}

export async function deleteKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_NAME, { keychainService: KEY_SERVICE, ...accessGroup() });
  // A key from before the shared group (1.0 without autofill).
  await SecureStore.deleteItemAsync(KEY_NAME, { keychainService: KEY_SERVICE }).catch(() => {});
}

export const expoAes: AesGcm = {
  async seal(plaintext, keyBase64, additionalData) {
    const key = await AESEncryptionKey.import(keyBase64, 'base64');
    const sealed = await aesEncryptAsync(plaintext, key, { additionalData });
    return sealed.combined('bytes');
  },
  async open(combined, keyBase64, additionalData) {
    const key = await AESEncryptionKey.import(keyBase64, 'base64');
    return aesDecryptAsync(AESSealedData.fromCombined(combined), key, { additionalData, output: 'bytes' });
  },
};

/** The App Group the AutoFill extension shares (iOS); app.json and targets/autofill name it too. */
export const APP_GROUP = 'group.com.weldsuite.weldpass';

/**
 * Where the copies live. iOS: the App Group container the AutoFill extension
 * shares, excluded from iCloud backup (falling back to the app's documents in
 * a build without the group). Android: the app's own storage, not backed up
 * (`allowBackup` is off), where the autofill service reads it.
 */
function root(): Directory {
  if (Platform.OS === 'ios') {
    const shared = Paths.appleSharedContainers[APP_GROUP];
    if (shared) return shared;
  }
  return Paths.document;
}

function folder(): Directory {
  const directory = new Directory(root(), 'weldpass-offline');
  if (!directory.exists) {
    directory.create({ intermediates: true, idempotent: true });
    weldPassNative?.excludeFromBackup?.(directory.uri);
  }
  return directory;
}

function fileName(workspaceId: string): string {
  return `${workspaceId.replace(/[^A-Za-z0-9_-]/g, '_')}.wpo`;
}

function fileFor(workspaceId: string): File {
  return new File(folder(), fileName(workspaceId));
}

export function readCopyFile(workspaceId: string): Uint8Array | null {
  const file = fileFor(workspaceId);
  return file.exists ? file.bytesSync() : null;
}

interface IndexEntry {
  workspaceId: string;
  deviceId: string;
  file: string;
}

/**
 * `index.json`: which file is which workspace's, and its device, so the
 * extension and the service can build each file's additional data. Ids only.
 */
function writeIndex(change: (entries: IndexEntry[]) => IndexEntry[]): void {
  const file = new File(folder(), 'index.json');
  let entries: IndexEntry[] = [];
  try {
    if (file.exists) entries = JSON.parse(file.textSync()) as IndexEntry[];
  } catch {
    entries = [];
  }
  const next = change(Array.isArray(entries) ? entries : []);
  if (file.exists) file.delete();
  file.write(JSON.stringify(next));
}

/** Written to a temporary file and moved over the old one, so a crash never leaves half a copy. */
export function writeCopyFile(workspaceId: string, bytes: Uint8Array, deviceId: string): void {
  const target = fileFor(workspaceId);
  const temporary = new File(folder(), `${target.name}.tmp`);
  if (temporary.exists) temporary.delete();
  temporary.write(bytes);
  if (target.exists) target.delete();
  temporary.moveSync(target);
  writeIndex((entries) => [
    ...entries.filter((entry) => entry.workspaceId !== workspaceId),
    { workspaceId, deviceId, file: fileName(workspaceId) },
  ]);
}

export function deleteCopyFile(workspaceId: string): void {
  const file = fileFor(workspaceId);
  if (file.exists) file.delete();
  writeIndex((entries) => entries.filter((entry) => entry.workspaceId !== workspaceId));
}

/** The fills the extension / service queued for the trail. */
export function fillsFile(): File {
  return new File(folder(), 'fills.json');
}

/** Every copy on the phone, and the autofill side's key and list: sign-out and a server switch. */
export function deleteAllCopyFiles(): void {
  const directory = new Directory(root(), 'weldpass-offline');
  if (directory.exists) directory.delete();
  weldPassNative?.clearAutofillKey?.();
  void weldPassNative?.clearCredentialIdentities?.();
}
