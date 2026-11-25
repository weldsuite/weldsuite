/**
 * The offline copy in the running app (ADR PASS-010).
 *
 * - **Unlocking** the app reads the copy's key, which is itself behind Face ID
 *   or the fingerprint, so one prompt unlocks the app and opens the copy
 *   (`unlock`, wired as the lock's `authenticate`). Phones that can't hold
 *   such a key (no enrolled biometrics) and servers without devices run
 *   online only, as before.
 * - **Syncing** happens after every unlock, when the app comes back to the
 *   foreground (at most every 30 s) and after every write.
 * - **Reading**: lists, search and item fields come from the copy while it
 *   is open, so the app works without a connection. Edits go to the server.
 * - **Wiping**: on sign-out (this phone is revoked on the server first), on a
 *   server switch, when the server says the phone was revoked or offline
 *   copies are off, and per vault when the person loses access.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { useQueryClient } from '@tanstack/react-query';
import { isApiError, isNetworkError } from '@weldsuite/api-client/client';
import type { DeviceEventAction } from '@weldsuite/app-api-client/domains/weldpass-devices';
import { onClearServerData, peekMobileRuntime } from '@weldsuite/mobile-platform/runtime';
import { useAuthSession } from '@weldsuite/mobile-ui/contexts/AuthContext';

import { findItem, type OfflineCopy } from '@/lib/offline/copy';
import {
  clearRevoked,
  loadCopy,
  OfflineUnsupportedError,
  revokedAt,
  revokeThisDevice,
  storedDeviceId,
  syncCopy,
  wipeEverything,
  wipeWorkspace,
  type OfflineDeps,
  type OfflineSession,
} from '@/lib/offline/engine';
import { collectFills, credentialIdentities, handKeyToAutofill, publishIdentities } from '@/lib/offline/autofill';
import { queueEvent } from '@/lib/offline/events';
import {
  canHoldKey,
  createKey,
  deleteAllCopyFiles,
  deleteCopyFile,
  deleteKey,
  expoAes,
  fillsFile,
  readCopyFile,
  readKey,
  writeCopyFile,
} from '@/lib/offline/native';
import { appApi } from '@/services/app-api';

export type OfflineStatus =
  /** Signed out, or the server doesn't offer offline copies (Global, an older self-hosted server). */
  | 'off'
  /** This phone can't keep a key behind biometrics. */
  | 'unavailable'
  /** Waiting for the person to unlock. */
  | 'locked'
  /** The copy is open (it may still be empty until the first sync). */
  | 'ready'
  /** The workspace switched offline copies off. */
  | 'disabled'
  /** This phone's copy was revoked; it stays off until turned on again. */
  | 'revoked';

export interface OfflineValue {
  status: OfflineStatus;
  /** Open and holding at least one sync's worth of data. */
  copy: OfflineCopy | null;
  syncing: boolean;
  /** The last sync couldn't reach the server: the lists are the copy from `copy.syncedAt`. */
  offline: boolean;
  /** For the lock: read the key (one prompt), open the copy. Null: no copy here, use the system prompt. */
  unlock: (prompt: string) => Promise<boolean | null>;
  /** After the lock lets the person in. */
  onUnlocked: () => void;
  sync: () => Promise<void>;
  /** A reveal, copy or autofill done from the copy, for the vault's trail. */
  recordEvent: (vaultId: string, itemId: string, action: DeviceEventAction) => void;
  /** Turn the copy on again after a revoke. */
  enableAgain: () => Promise<void>;
  /** Revoke this phone, wipe its copy and key, then sign out. */
  signOut: () => Promise<void>;
}

const OfflineContext = createContext<OfflineValue | null>(null);

export function useOffline(): OfflineValue {
  const value = useContext(OfflineContext);
  if (!value) throw new Error('useOffline must be used within an OfflineProvider');
  return value;
}

/** The copy's item, when the copy is open (the item screen reads its fields from it). */
export function useCopiedItem(vaultId: string, itemId: string) {
  const { copy } = useOffline();
  return copy ? findItem(copy, vaultId, itemId) : null;
}

const FOREGROUND_SYNC_MS = 30_000;

const deps: OfflineDeps = {
  store: AsyncStorage,
  api: appApi.devices,
  aes: expoAes,
  files: {
    read: readCopyFile,
    write: writeCopyFile,
    delete: deleteCopyFile,
    deleteAll: deleteAllCopyFiles,
  },
  device: () => ({
    name: (Device.deviceName || Device.modelName || 'Phone').slice(0, 100),
    platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'other',
    appVersion: Constants.expoConfig?.version ?? null,
  }),
};

/** Everything on the phone, the key included. */
async function wipeAll(): Promise<void> {
  try {
    await wipeEverything(deps);
  } finally {
    await deleteKey().catch(() => {});
  }
}

export function OfflineProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { user, organizationId, signOut: signOutSession } = useAuthSession();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<OfflineStatus>('off');
  const [copy, setCopy] = useState<OfflineCopy | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [offline, setOffline] = useState(false);
  const key = useRef<string | null>(null);
  const copyRef = useRef<OfflineCopy | null>(null);
  const syncingRef = useRef(false);
  const lastAttempt = useRef(0);
  const wasSignedIn = useRef(false);

  const runtime = peekMobileRuntime();
  const server = runtime?.server.origin ?? runtime?.apiOrigin ?? null;
  const featureOff = !runtime || runtime.unavailableFeatures.has('weldpass-offline');
  const userId = user?.id ?? null;
  const session = useMemo<OfflineSession | null>(
    () => (userId && organizationId && server ? { server, userId, workspaceId: organizationId } : null),
    [organizationId, server, userId],
  );

  const setOpenCopy = useCallback((next: OfflineCopy | null) => {
    copyRef.current = next;
    setCopy(next);
  }, []);

  // Which state a session starts in.
  useEffect(() => {
    setOpenCopy(null);
    setOffline(false);
    if (!session || featureOff) {
      setStatus('off');
      return;
    }
    if (!canHoldKey()) {
      setStatus('unavailable');
      return;
    }
    let cancelled = false;
    void revokedAt(deps, session).then((revoked) => {
      if (cancelled) return;
      if (revoked) setStatus('revoked');
      else setStatus(key.current ? 'ready' : 'locked');
    });
    return () => {
      cancelled = true;
    };
  }, [featureOff, session, setOpenCopy]);

  // Another workspace while unlocked: open its copy straight away.
  useEffect(() => {
    if (!session || !key.current || status !== 'ready' || copyRef.current) return;
    void (async () => {
      const deviceId = await storedDeviceId(deps, session);
      if (deviceId && key.current) setOpenCopy(await loadCopy(deps, { ...session, deviceId }, key.current));
    })();
  }, [session, setOpenCopy, status]);

  // Signed out by any route (an expired session too): nothing stays behind.
  useEffect(() => {
    if (user) {
      wasSignedIn.current = true;
      return;
    }
    if (!wasSignedIn.current) return;
    wasSignedIn.current = false;
    key.current = null;
    setOpenCopy(null);
    void wipeAll();
  }, [setOpenCopy, user]);

  // A server switch clears everything of the old server.
  useEffect(
    () =>
      onClearServerData('weldpass-offline', async () => {
        key.current = null;
        await wipeAll();
      }),
    [],
  );

  const sync = useCallback(async () => {
    if (!session || !key.current || syncingRef.current) return;
    if (status === 'off' || status === 'unavailable' || status === 'revoked') return;
    syncingRef.current = true;
    lastAttempt.current = Date.now();
    setSyncing(true);
    try {
      // Fills done by the AutoFill extension / autofill service, for the trail.
      await collectFills(fillsFile(), AsyncStorage).catch(() => 0);
      const run = await syncCopy(deps, session, key.current, copyRef.current);
      setOffline(false);
      if (run.kind === 'wiped') {
        setOpenCopy(null);
        setStatus(run.reason === 'disabled' ? 'disabled' : 'revoked');
      } else {
        setOpenCopy(run.copy);
        setStatus('ready');
        // iOS: QuickType suggestions (hosts and usernames, never a password).
        void publishIdentities(credentialIdentities([run.copy])).catch(() => {});
      }
      void queryClient.invalidateQueries({ queryKey: ['weldpass', session.workspaceId] });
    } catch (error) {
      if (isNetworkError(error)) setOffline(true);
      else if (error instanceof OfflineUnsupportedError) setStatus('off');
      else if (isApiError(error) && error.status === 403) setStatus('off');
      // Anything else: the copy stays as it is; the next trigger tries again.
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [queryClient, session, setOpenCopy, status]);

  const unlock = useCallback(
    async (prompt: string): Promise<boolean | null> => {
      // Decided from what is known at once, not from `status`: the lock's
      // first prompt on a cold start can come before the status has settled.
      if (!session || featureOff || !canHoldKey()) return null;
      try {
        let value = await readKey(prompt);
        if (!value) {
          value = await createKey(prompt);
          // iOS stores a new key without asking: ask now, by reading it back.
          if (Platform.OS === 'ios' && !(await readKey(prompt))) return false;
        }
        key.current = value;
        // Android: the autofill service gets the key, wrapped, within the unlock's window.
        handKeyToAutofill(value);
      } catch (error) {
        if (/cancel/i.test(error instanceof Error ? error.message : String(error))) return false;
        // The key no longer opens (biometrics were changed): drop it, let
        // the system prompt decide, and make a new key at the next unlock.
        await deleteKey().catch(() => {});
        if (session) deleteCopyFile(session.workspaceId);
        return null;
      }
      if (!copyRef.current) {
        const deviceId = await storedDeviceId(deps, session);
        if (deviceId) setOpenCopy(await loadCopy(deps, { ...session, deviceId }, key.current));
      }
      setStatus((current) => (current === 'locked' ? 'ready' : current));
      return true;
    },
    [featureOff, session, setOpenCopy],
  );

  const onUnlocked = useCallback(() => {
    void sync();
  }, [sync]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && Date.now() - lastAttempt.current > FOREGROUND_SYNC_MS) void sync();
    });
    return () => subscription.remove();
  }, [sync]);

  const recordEvent = useCallback(
    (vaultId: string, itemId: string, action: DeviceEventAction) => {
      if (!session) return;
      void queueEvent(AsyncStorage, session.workspaceId, { vaultId, itemId, action }).catch(() => {});
    },
    [session],
  );

  const enableAgain = useCallback(async () => {
    if (!session) return;
    await clearRevoked(deps, session);
    await wipeWorkspace(deps, session);
    setStatus(key.current ? 'ready' : 'locked');
  }, [session]);

  const signOut = useCallback(async () => {
    if (session) await revokeThisDevice(deps, session);
    key.current = null;
    setOpenCopy(null);
    await wipeAll();
    await signOutSession();
  }, [session, setOpenCopy, signOutSession]);

  // Unlocked with an open copy but never synced (first unlock): sync now.
  useEffect(() => {
    if (status === 'ready' && key.current && !copyRef.current?.syncedAt) void sync();
  }, [status, sync]);

  const value = useMemo<OfflineValue>(
    () => ({
      status,
      copy: copy?.syncedAt ? copy : null,
      syncing,
      offline,
      unlock,
      onUnlocked,
      sync,
      recordEvent,
      enableAgain,
      signOut,
    }),
    [copy, enableAgain, offline, onUnlocked, recordEvent, signOut, status, sync, syncing, unlock],
  );

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}
