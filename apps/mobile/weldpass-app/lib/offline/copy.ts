/**
 * The offline copy of the vaults (ADR PASS-010), as it lives in memory once
 * decrypted, and the rules for applying a sync to it. Pure: no storage, no
 * crypto, no React, so the merge can be tested directly.
 *
 * One copy per workspace. It is bound to the server, the person and the
 * device it was synced for: a copy that names anything else is never read.
 */

import type {
  WeldPassSyncedItem,
  WeldPassSyncResult,
} from '@weldsuite/app-api-client/domains/weldpass-devices';
import type { WeldPassItem, WeldPassVault } from '@weldsuite/app-api-client/domains/weldpass-passwords';

export const COPY_VERSION = 1;

/** Who and where the copy belongs to. */
export interface CopyOwner {
  /** The server's origin (`https://app.weldsuite.eu`). */
  server: string;
  userId: string;
  workspaceId: string;
  deviceId: string;
}

export interface CopiedVault {
  vault: WeldPassVault;
  cursor: string;
  items: Record<string, WeldPassSyncedItem>;
}

export interface OfflineCopy extends CopyOwner {
  version: typeof COPY_VERSION;
  /** The server's clock at the last sync. */
  syncedAt: string;
  vaults: Record<string, CopiedVault>;
}

export function emptyCopy(owner: CopyOwner): OfflineCopy {
  return { version: COPY_VERSION, ...owner, syncedAt: '', vaults: {} };
}

/** Whether a copy read from storage belongs to `owner`. */
export function belongsTo(copy: OfflineCopy, owner: CopyOwner): boolean {
  return (
    copy.version === COPY_VERSION &&
    copy.server === owner.server &&
    copy.userId === owner.userId &&
    copy.workspaceId === owner.workspaceId &&
    copy.deviceId === owner.deviceId
  );
}

/** The cursors to send: one per vault the copy holds. */
export function cursorsOf(copy: OfflineCopy | null): Record<string, string> {
  const cursors: Record<string, string> = {};
  for (const [id, vault] of Object.entries(copy?.vaults ?? {})) cursors[id] = vault.cursor;
  return cursors;
}

export type SyncOutcome =
  | { kind: 'wiped'; reason: 'revoked' | 'disabled' | null }
  | { kind: 'updated'; copy: OfflineCopy; removedVaultIds: string[]; changed: boolean };

/**
 * Apply a sync. The server lists every vault the person can read now, so a
 * vault the copy holds but the answer leaves out is dropped as well as the
 * ones named in `removedVaultIds`.
 */
export function applySync(copy: OfflineCopy, result: WeldPassSyncResult): SyncOutcome {
  if (result.wipe) return { kind: 'wiped', reason: result.reason };

  const readable = new Set(result.vaults.map((entry) => entry.vault.id));
  const removed = new Set(result.removedVaultIds);
  for (const id of Object.keys(copy.vaults)) if (!readable.has(id)) removed.add(id);

  let changed = removed.size > 0;
  const vaults: Record<string, CopiedVault> = {};
  for (const entry of result.vaults) {
    const merged = mergeVault(copy.vaults[entry.vault.id], entry);
    vaults[entry.vault.id] = merged.vault;
    changed ||= merged.changed;
  }

  return {
    kind: 'updated',
    copy: { ...copy, syncedAt: result.syncedAt, vaults },
    removedVaultIds: [...removed],
    changed,
  };
}

/** One vault of a sync over what the copy held of it: replaced when `full`, else merged. */
function mergeVault(
  previous: CopiedVault | undefined,
  entry: WeldPassSyncResult['vaults'][number],
): { vault: CopiedVault; changed: boolean } {
  const replaced = entry.full || !previous;
  const items: Record<string, WeldPassSyncedItem> = replaced ? {} : { ...previous.items };
  let changed = !previous || (entry.full && Object.keys(previous.items).length > 0) || entry.items.length > 0;
  for (const id of entry.deletedIds) {
    if (id in items) changed = true;
    delete items[id];
  }
  for (const item of entry.items) items[item.id] = item;
  return { vault: { vault: entry.vault, cursor: entry.cursor, items }, changed };
}

/** The vaults, as the vault list returns them, with their item counts from the copy. */
export function vaultsOf(copy: OfflineCopy): WeldPassVault[] {
  return Object.values(copy.vaults).map(({ vault, items }) => ({
    ...vault,
    itemCount: Object.keys(items).length,
  }));
}

/** Every item, as the item list returns them: the metadata, never the fields. */
export function itemsOf(copy: OfflineCopy): WeldPassItem[] {
  const list: WeldPassItem[] = [];
  for (const { items } of Object.values(copy.vaults)) {
    for (const item of Object.values(items)) list.push(withoutFields(item));
  }
  return list;
}

export function findItem(copy: OfflineCopy, vaultId: string, itemId: string): WeldPassSyncedItem | null {
  return copy.vaults[vaultId]?.items[itemId] ?? null;
}

function withoutFields(item: WeldPassSyncedItem): WeldPassItem {
  const summary: Partial<WeldPassSyncedItem> = { ...item };
  delete summary.fields;
  return summary as WeldPassItem;
}
