/**
 * Device connectivity state, surfaced app-wide.
 *
 * Phase 0 of offline support: a single NetInfo subscription that the rest of
 * the app reads via `useNetworkStatus()`. It does NOT queue or retry anything
 * yet — that's Phase 2. For now it powers the OfflineBanner and gives future
 * phases (read cache revalidation, write outbox flush) a reliable signal for
 * "we just came back online".
 *
 * `isOnline` intentionally errs optimistic: NetInfo reports `isConnected` as
 * `null` while it's still resolving on cold start, and we treat unknown as
 * online so we never block a working device behind a false "offline" banner.
 * `isInternetReachable` is the stricter signal (a connected-but-captive-portal
 * Wi-Fi reports connected=true, reachable=false); consumers that need a real
 * round-trip should prefer it.
 */

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';

interface NetworkStatus {
  /** Device has a network interface up. Optimistic: unknown (null) → true. */
  isOnline: boolean;
  /** The internet is actually reachable (stricter than isOnline). null = unknown. */
  isInternetReachable: boolean | null;
  /** Flips false→true the first time we observe a return to connectivity. */
  wasOffline: boolean;
}

const NetworkContext = createContext<NetworkStatus>({
  isOnline: true,
  isInternetReachable: null,
  wasOffline: false,
});

export const useNetworkStatus = () => useContext(NetworkContext);

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [isOnline, setIsOnline] = useState(true);
  const [isInternetReachable, setIsInternetReachable] = useState<boolean | null>(null);
  const [wasOffline, setWasOffline] = useState(false);
  // Track the previous online state so we can expose a one-shot "recovered"
  // signal for Phase 2 (flush the outbox the moment we reconnect).
  const wasOfflineRef = useRef(false);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      // Treat unknown (null) as online — see file header.
      const online = state.isConnected ?? true;
      setIsOnline(online);
      setIsInternetReachable(state.isInternetReachable);

      if (!online) {
        wasOfflineRef.current = true;
        setWasOffline(true);
      } else if (wasOfflineRef.current) {
        // We were offline and just came back. Keep wasOffline truthy for one
        // render so listeners can react, then reset it.
        wasOfflineRef.current = false;
        setWasOffline(false);
      }
    });

    return () => unsubscribe();
  }, []);

  return (
    <NetworkContext.Provider value={{ isOnline, isInternetReachable, wasOffline }}>
      {children}
    </NetworkContext.Provider>
  );
}
