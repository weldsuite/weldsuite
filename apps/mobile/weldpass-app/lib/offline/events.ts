/**
 * What the phone did with its copy (a reveal, a copy, an autofill), queued
 * until the next sync uploads it into the vaults' trails (ADR PASS-010).
 * Ids and actions only, never a secret.
 */

import type { DeviceEventAction, WeldPassDeviceEvent } from '@weldsuite/app-api-client/domains/weldpass-devices';

export interface KeyValue {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** The server takes at most 500 per request; older events are dropped past this many. */
export const MAX_QUEUED_EVENTS = 2000;
export const EVENTS_PER_UPLOAD = 500;

function queueKey(workspaceId: string): string {
  return `weldpass:offline-events:${workspaceId}`;
}

export async function readEvents(store: KeyValue, workspaceId: string): Promise<WeldPassDeviceEvent[]> {
  try {
    const raw = await store.getItem(queueKey(workspaceId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as WeldPassDeviceEvent[]) : [];
  } catch {
    return [];
  }
}

export async function queueEvent(
  store: KeyValue,
  workspaceId: string,
  event: { vaultId: string; itemId: string; action: DeviceEventAction; at?: Date },
): Promise<void> {
  await queueEvents(store, workspaceId, [event]);
}

/** Several events at once: one read and one write of the workspace's queue. */
export async function queueEvents(
  store: KeyValue,
  workspaceId: string,
  added: readonly { vaultId: string; itemId: string; action: DeviceEventAction; at?: Date }[],
): Promise<void> {
  if (added.length === 0) return;
  const events = await readEvents(store, workspaceId);
  for (const event of added) {
    events.push({
      vaultId: event.vaultId,
      itemId: event.itemId,
      action: event.action,
      at: (event.at ?? new Date()).toISOString(),
    });
  }
  await store.setItem(queueKey(workspaceId), JSON.stringify(events.slice(-MAX_QUEUED_EVENTS)));
}

/**
 * Upload the queue in batches. Each batch the server took is removed, so a
 * failure part-way keeps only what wasn't sent.
 */
export async function flushEvents(
  store: KeyValue,
  workspaceId: string,
  upload: (events: WeldPassDeviceEvent[]) => Promise<unknown>,
): Promise<number> {
  let events = await readEvents(store, workspaceId);
  let sent = 0;
  while (events.length > 0) {
    const batch = events.slice(0, EVENTS_PER_UPLOAD);
    await upload(batch);
    sent += batch.length;
    events = events.slice(batch.length);
    if (events.length === 0) await store.removeItem(queueKey(workspaceId));
    else await store.setItem(queueKey(workspaceId), JSON.stringify(events));
  }
  return sent;
}

export async function clearEvents(store: KeyValue, workspaceId: string): Promise<void> {
  await store.removeItem(queueKey(workspaceId));
}
