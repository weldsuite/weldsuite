/**
 * Which partner the portal acts as. A user can belong to several partners; the
 * choice is remembered per browser and sent as `X-Partner-Id` on portal calls.
 *
 * A tiny external store rather than context state so the API client (which reads
 * it per request) and React (via `useSyncExternalStore`) always agree.
 */

const STORAGE_KEY = 'weldsuite:partner-id';

let current: string | null | undefined;
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // storage unavailable (private mode / blocked) — fall back to the in-memory value
    return null;
  }
}

export function getSelectedPartnerId(): string | null {
  if (current === undefined) current = read();
  return current;
}

export function setSelectedPartnerId(partnerId: string | null): void {
  current = partnerId;
  try {
    if (partnerId) window.localStorage.setItem(STORAGE_KEY, partnerId);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable — the in-memory value still applies for this tab
  }
  for (const listener of listeners) listener();
}

export function subscribeSelectedPartner(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
