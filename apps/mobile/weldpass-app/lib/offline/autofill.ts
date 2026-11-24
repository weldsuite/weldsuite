/**
 * The app's side of native autofill (ADR PASS-010, phase 4C).
 *
 * - **iOS:** after each sync, the system's credential identity store gets
 *   every login's host and username (never a password), so QuickType can
 *   suggest them; the AutoFill extension reads the copy itself.
 * - **Android:** after each unlock, the copy's key goes to the autofill
 *   service, wrapped with a Keystore key of its own (`storeAutofillKey`).
 * - **Both:** fills done by the extension / service are queued in
 *   `fills.json` next to the copy; they are uploaded as `autofilled` device
 *   events at the next sync.
 * - **Index:** `index.json` next to the copies tells the extension / service
 *   which file belongs to which workspace and device (ids only).
 */

import { Platform } from 'react-native';
import type { File } from 'expo-file-system';
import type { WeldPassSyncedItem } from '@weldsuite/app-api-client/domains/weldpass-devices';

import { weldPassNative } from '@/modules/weldpass-native';

import type { OfflineCopy } from './copy';
import { queueEvent, type KeyValue } from './events';

/** `serviceIdentifier` (a host) + username + where to find the item again. Nothing secret. */
export interface CredentialIdentity {
  host: string;
  username: string;
  recordIdentifier: string;
}

/** A login's identity, or null for anything without a host and a username. */
function identityOf(workspaceId: string, item: WeldPassSyncedItem): CredentialIdentity | null {
  const username = 'username' in item.fields ? item.fields.username : '';
  if (item.type !== 'login' || !item.host || !username) return null;
  return { host: item.host, username, recordIdentifier: `${workspaceId}/${item.vaultId}/${item.id}` };
}

/** Every login with a host and a username, across the copies on the phone. */
export function credentialIdentities(copies: readonly OfflineCopy[]): CredentialIdentity[] {
  return copies.flatMap((copy) =>
    Object.values(copy.vaults).flatMap((vault) =>
      Object.values(vault.items)
        .map((item) => identityOf(copy.workspaceId, item))
        .filter((identity): identity is CredentialIdentity => identity !== null),
    ),
  );
}

/** iOS: replace the system's identity store with `identities`. */
export async function publishIdentities(identities: CredentialIdentity[]): Promise<void> {
  if (Platform.OS !== 'ios') return;
  await weldPassNative?.replaceCredentialIdentities?.(JSON.stringify(identities));
}

/** Android: give the autofill service the key, right after an unlock (its window is 30 s). */
export function handKeyToAutofill(keyBase64: string): void {
  if (Platform.OS !== 'android') return;
  weldPassNative?.storeAutofillKey?.(keyBase64);
}

interface Fill {
  workspaceId: string;
  vaultId: string;
  itemId: string;
  at: string;
}

/** Move the extension's / service's fills into the device event queue. */
export async function collectFills(fillsFile: File, store: KeyValue): Promise<number> {
  if (!fillsFile.exists) return 0;
  let fills: Fill[] = [];
  try {
    const parsed: unknown = JSON.parse(fillsFile.textSync());
    if (Array.isArray(parsed)) fills = parsed as Fill[];
  } catch {
    // A broken queue is dropped.
  }
  fillsFile.delete();
  for (const fill of fills) {
    await queueEvent(store, fill.workspaceId, {
      vaultId: fill.vaultId,
      itemId: fill.itemId,
      action: 'autofilled',
      at: new Date(fill.at),
    });
  }
  return fills.length;
}
