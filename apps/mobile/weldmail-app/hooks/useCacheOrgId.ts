/**
 * Stable cache scope id.
 *
 * The offline cache is namespaced by the Clerk organization id. The raw
 * `useOrganization()` id, however, hydrates late and *unreliably* on iOS — it
 * flaps null → value → null even while the session token stays org-scoped and
 * the server keeps answering correctly. Scoping the cache directly on that
 * signal made the cache thrash: it would disable mid-session (losing the instant
 * offline paint) and the read side (`useMailCache`) disagreed with the write
 * side (`MailContext`, which still wrote under a `'no-org'` bucket).
 *
 * This hook removes the flapping by *latching* the org id:
 *  - The first real org id seen is remembered in a process-wide store AND
 *    persisted, so the next cold start is scoped correctly before Clerk
 *    re-hydrates the org.
 *  - Once latched it never falls back to null for a transient hydration gap —
 *    the cache stays enabled and stable for the whole session.
 *  - On a real workspace switch or sign-out the previous org's cache is dropped
 *    so one account's mail can never surface under another.
 *
 * The latch lives in an external store read via `useSyncExternalStore`, so every
 * consumer (message cache + accounts/labels cache) re-renders together the
 * instant it changes and they always agree on the scope.
 */

import { useEffect, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { clearOrgCache } from '@/lib/offline/cache';

const LATCH_KEY = 'weldmail.cache.orgId';

// Process-wide latch shared by every hook instance.
let latch: string | null = null;
let hydrateStarted = false;
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): string | null {
  return latch;
}

function setLatch(next: string | null): void {
  if (latch === next) return;
  latch = next;
  listeners.forEach((l) => l());
}

export function useCacheOrgId(): string | null {
  const { organizationId, isSignedIn } = useClerkAuth();
  const latched = useSyncExternalStore(subscribe, getSnapshot);

  // Hydrate the persisted latch exactly once per process so a cold start is
  // scoped to the right org before Clerk resolves the active organization.
  useEffect(() => {
    if (hydrateStarted) return;
    hydrateStarted = true;
    AsyncStorage.getItem(LATCH_KEY)
      .then((v) => {
        if (v && !latch) setLatch(v);
      })
      .catch(() => {});
  }, []);

  // Latch the live org id the instant it resolves and persist it. A genuine
  // org→org switch drops the previous org's cached mail first.
  useEffect(() => {
    if (organizationId && organizationId !== latch) {
      const prev = latch;
      setLatch(organizationId);
      AsyncStorage.setItem(LATCH_KEY, organizationId).catch(() => {});
      if (prev && prev !== organizationId) clearOrgCache(prev);
    }
  }, [organizationId]);

  // On sign-out, forget the latch and wipe its cache so a different user signing
  // in on the same device never reads the previous user's mail.
  useEffect(() => {
    if (isSignedIn === false && latch) {
      const prev = latch;
      setLatch(null);
      AsyncStorage.removeItem(LATCH_KEY).catch(() => {});
      if (prev) clearOrgCache(prev);
    }
  }, [isSignedIn]);

  // Live id wins the moment it's present; otherwise fall back to the stable
  // latch. Only ever null on the very first launch before any org is known —
  // when there's nothing cached to show anyway.
  return organizationId ?? latched;
}
