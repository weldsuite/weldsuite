/**
 * Stable cache scope id for WeldChat.
 *
 * Latches the Clerk organization id so AsyncStorage cache keys don't thrash
 * when `useOrganization()` flaps null → value → null during iOS hydration.
 * On a real org switch or sign-out the previous org's cache is cleared.
 *
 * Mirrors weldmail-app/hooks/useCacheOrgId.ts.
 */

import { useEffect, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { clearOrgCache } from '@/lib/offline/cache';

const LATCH_KEY = 'weldchat.cache.orgId';

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

  useEffect(() => {
    if (hydrateStarted) return;
    hydrateStarted = true;
    AsyncStorage.getItem(LATCH_KEY)
      .then((v) => {
        if (v && !latch) setLatch(v);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (organizationId && organizationId !== latch) {
      const prev = latch;
      setLatch(organizationId);
      AsyncStorage.setItem(LATCH_KEY, organizationId).catch(() => {});
      if (prev && prev !== organizationId) clearOrgCache(prev);
    }
  }, [organizationId]);

  useEffect(() => {
    if (isSignedIn === false && latch) {
      const prev = latch;
      setLatch(null);
      AsyncStorage.removeItem(LATCH_KEY).catch(() => {});
      if (prev) clearOrgCache(prev);
    }
  }, [isSignedIn]);

  return organizationId ?? latched;
}
