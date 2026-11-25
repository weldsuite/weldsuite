/**
 * Syncing the offline copy (ADR PASS-010): register the phone once per
 * server, person and workspace; send a cursor per vault; apply the answer;
 * seal the copy again; upload what was done offline. Wipe on the server's
 * say-so. Everything native comes in through `OfflineDeps`, so this runs in
 * Jest as it runs on the phone.
 */

import { isApiError } from '@weldsuite/api-client/client';
import type { WeldPassDevicesApi } from '@weldsuite/app-api-client/domains/weldpass-devices';

import { applySync, belongsTo, cursorsOf, emptyCopy, type CopyOwner, type OfflineCopy } from './copy';
import { openCopy, sealCopy, type AesGcm } from './envelope';
import { clearEvents, flushEvents, type KeyValue } from './events';

export interface CopyFiles {
  read(workspaceId: string): Uint8Array | null;
  /** `deviceId` goes into the index the native autofill reads (phase 4C). */
  write(workspaceId: string, bytes: Uint8Array, deviceId: string): void;
  delete(workspaceId: string): void;
  deleteAll(): void;
}

export interface OfflineDeps {
  store: KeyValue & { getAllKeys?: () => Promise<readonly string[]> };
  api: Pick<WeldPassDevicesApi, 'registerDevice' | 'sync' | 'uploadEvents' | 'revokeDevice'>;
  aes: AesGcm;
  files: CopyFiles;
  device: () => { name: string; platform: 'ios' | 'android' | 'other'; appVersion: string | null };
}

/** Where the copy belongs, before a device id is known. */
export interface OfflineSession {
  server: string;
  userId: string;
  workspaceId: string;
}

/** The server has no device routes (a self-hosted install older than PASS-010). */
export class OfflineUnsupportedError extends Error {
  constructor() {
    super('This server keeps no offline copies');
    this.name = 'OfflineUnsupportedError';
  }
}

const DEVICE_PREFIX = 'weldpass:device:';

function deviceKey(session: OfflineSession): string {
  return `${DEVICE_PREFIX}${session.server}|${session.userId}|${session.workspaceId}`;
}

export async function storedDeviceId(deps: OfflineDeps, session: OfflineSession): Promise<string | null> {
  return deps.store.getItem(deviceKey(session));
}

/** This phone's device id on the server, registering it the first time. */
export async function ensureDevice(deps: OfflineDeps, session: OfflineSession): Promise<string> {
  const known = await storedDeviceId(deps, session);
  if (known) return known;
  try {
    const { data } = await deps.api.registerDevice(deps.device());
    await deps.store.setItem(deviceKey(session), data.id);
    return data.id;
  } catch (error) {
    if (isApiError(error) && (error.status === 404 || error.status === 405)) throw new OfflineUnsupportedError();
    throw error;
  }
}

/**
 * The copy on the phone for this session, opened with `key`. A missing file,
 * one that doesn't open (another key, tampering) or one that belongs to
 * someone else starts an empty copy; the next sync fills it from scratch.
 */
export async function loadCopy(deps: OfflineDeps, owner: CopyOwner, key: string): Promise<OfflineCopy> {
  const bytes = deps.files.read(owner.workspaceId);
  if (!bytes) return emptyCopy(owner);
  try {
    const copy = await openCopy(bytes, key, owner, deps.aes);
    if (belongsTo(copy, owner)) return copy;
  } catch {
    // Falls through to a fresh copy.
  }
  deps.files.delete(owner.workspaceId);
  return emptyCopy(owner);
}

export type SyncRun =
  | { kind: 'synced'; copy: OfflineCopy; removedVaultIds: string[] }
  | { kind: 'wiped'; reason: 'revoked' | 'disabled' | null };

/** One sync. Throws `NetworkError` offline, `OfflineUnsupportedError` on a server without devices. */
export async function syncCopy(
  deps: OfflineDeps,
  session: OfflineSession,
  key: string,
  current: OfflineCopy | null,
): Promise<SyncRun> {
  if (await revokedAt(deps, session)) return { kind: 'wiped', reason: 'revoked' };
  let deviceId = await ensureDevice(deps, session);
  let owner: CopyOwner = { ...session, deviceId };
  let copy = current && belongsTo(current, owner) ? current : await loadCopy(deps, owner, key);

  let result;
  try {
    result = (await deps.api.sync(deviceId, cursorsOf(copy))).data;
  } catch (error) {
    // The server no longer knows this device (its row is gone): register
    // again and start from scratch, once.
    if (!isApiError(error) || error.status !== 404) throw error;
    await deps.store.removeItem(deviceKey(session));
    deps.files.delete(session.workspaceId);
    deviceId = await ensureDevice(deps, session);
    owner = { ...session, deviceId };
    copy = emptyCopy(owner);
    result = (await deps.api.sync(deviceId, {})).data;
  }

  const outcome = applySync(copy, result);
  if (outcome.kind === 'wiped') {
    // Switched off by the workspace: keep the registration, so the phone
    // picks the copy up again when it's switched back on. Revoked: forget
    // it, and don't register again on our own (`markRevoked`).
    await wipeWorkspace(deps, session, { forgetDevice: outcome.reason !== 'disabled' });
    if (outcome.reason === 'revoked') await deps.store.setItem(revokedKey(session), new Date().toISOString());
    return { kind: 'wiped', reason: outcome.reason };
  }

  deps.files.write(session.workspaceId, await sealCopy(outcome.copy, key, deps.aes), deviceId);
  try {
    await flushEvents(deps.store, session.workspaceId, (events) => deps.api.uploadEvents(deviceId, events));
  } catch {
    // Kept for the next sync.
  }
  return { kind: 'synced', copy: outcome.copy, removedVaultIds: outcome.removedVaultIds };
}

/** This workspace's copy and queued events, and its device id unless told to keep it. */
export async function wipeWorkspace(
  deps: OfflineDeps,
  session: OfflineSession,
  options: { forgetDevice?: boolean } = {},
): Promise<void> {
  deps.files.delete(session.workspaceId);
  if (options.forgetDevice ?? true) await deps.store.removeItem(deviceKey(session));
  await clearEvents(deps.store, session.workspaceId);
}

const REVOKED_PREFIX = 'weldpass:offline-revoked:';

function revokedKey(session: OfflineSession): string {
  return `${REVOKED_PREFIX}${session.server}|${session.userId}|${session.workspaceId}`;
}

/**
 * When this phone's copy was revoked (ISO), if it was. A revoked phone
 * doesn't register again by itself: the person turns the copy on again in
 * Settings (`clearRevoked`), so revoking a lost phone sticks.
 */
export async function revokedAt(deps: OfflineDeps, session: OfflineSession): Promise<string | null> {
  return deps.store.getItem(revokedKey(session));
}

export async function clearRevoked(deps: OfflineDeps, session: OfflineSession): Promise<void> {
  await deps.store.removeItem(revokedKey(session));
}

/** Every copy and device id on the phone (sign-out, server switch). The key goes separately. */
export async function wipeEverything(deps: OfflineDeps): Promise<void> {
  deps.files.deleteAll();
  const keys = (await deps.store.getAllKeys?.()) ?? [];
  await Promise.all(
    keys
      .filter(
        (key) =>
          key.startsWith(DEVICE_PREFIX) || key.startsWith(REVOKED_PREFIX) || key.startsWith('weldpass:offline-events:'),
      )
      .map((key) => deps.store.removeItem(key)),
  );
}

/** Revoke this phone on the server before signing out, so the device list stays true. Best effort. */
export async function revokeThisDevice(deps: OfflineDeps, session: OfflineSession): Promise<void> {
  const deviceId = await storedDeviceId(deps, session);
  if (!deviceId) return;
  try {
    await deps.api.revokeDevice(deviceId);
  } catch {
    // Signing out never waits on the server.
  }
}
