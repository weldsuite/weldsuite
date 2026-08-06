/**
 * Offline capture queue.
 *
 * Receipts scanned and expenses entered without a connection are persisted to
 * AsyncStorage and replayed when connectivity returns. app-api has no bulk
 * intake endpoint, so `api.uploadOfflineQueue` posts each item individually and
 * reports per-item outcomes — anything that failed stays queued for the next
 * attempt rather than being silently dropped.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import api from '@/services/api';

const QUEUE_STORAGE_KEY = '@weldbooks/offline-queue';

export interface QueueItem {
  id: string;
  type: 'expense' | 'document';
  data: Record<string, unknown>;
  createdAt: string;
}

interface OfflineQueueContextType {
  queue: QueueItem[];
  isOnline: boolean;
  isSyncing: boolean;
  addToQueue: (item: Omit<QueueItem, 'id' | 'createdAt'>) => Promise<void>;
  syncQueue: () => Promise<void>;
  clearQueue: () => Promise<void>;
}

const OfflineQueueContext = createContext<OfflineQueueContextType>({
  queue: [],
  isOnline: true,
  isSyncing: false,
  addToQueue: async () => {},
  syncQueue: async () => {},
  clearQueue: async () => {},
});

export const useOfflineQueue = () => useContext(OfflineQueueContext);

export function OfflineQueueProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isOnline, setIsOnline] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const syncingRef = useRef(false);
  // Mirrors `queue` so the NetInfo listener and syncQueue always see the
  // current items without either re-subscribing on every queue change.
  const queueRef = useRef<QueueItem[]>([]);

  const persist = useCallback(async (items: QueueItem[]) => {
    queueRef.current = items;
    setQueue(items);
    try {
      await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(items));
    } catch (err) {
      console.error('Failed to save offline queue:', err);
    }
  }, []);

  const syncQueue = useCallback(async () => {
    const items = queueRef.current;
    if (syncingRef.current || items.length === 0) return;

    syncingRef.current = true;
    setIsSyncing(true);

    try {
      const results = await api.uploadOfflineQueue(
        items.map((item) => ({ type: item.type, data: item.data })),
      );

      // Keep only the items that failed; everything else made it to app-api.
      const failedIndices = new Set(results.filter((r) => r.error).map((r) => r.index));
      await persist(items.filter((_, i) => failedIndices.has(i)));
    } catch (err) {
      // A transport-level failure leaves the whole queue intact for the retry.
      console.error('Failed to sync offline queue:', err);
    } finally {
      syncingRef.current = false;
      setIsSyncing(false);
    }
  }, [persist]);

  // Restore the queue on mount.
  useEffect(() => {
    const loadQueue = async () => {
      try {
        const stored = await AsyncStorage.getItem(QUEUE_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as QueueItem[];
          queueRef.current = parsed;
          setQueue(parsed);
        }
      } catch (err) {
        console.error('Failed to load offline queue:', err);
      }
    };
    loadQueue();
  }, []);

  // Drain the queue whenever connectivity returns.
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const online = state.isConnected ?? true;
      setIsOnline(online);
      if (online && queueRef.current.length > 0 && !syncingRef.current) {
        void syncQueue();
      }
    });
    return () => unsubscribe();
  }, [syncQueue]);

  const addToQueue = useCallback(
    async (item: Omit<QueueItem, 'id' | 'createdAt'>) => {
      const newItem: QueueItem = {
        ...item,
        id: `oq_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        createdAt: new Date().toISOString(),
      };
      await persist([...queueRef.current, newItem]);
    },
    [persist],
  );

  const clearQueue = useCallback(() => persist([]), [persist]);

  return (
    <OfflineQueueContext.Provider
      value={{ queue, isOnline, isSyncing, addToQueue, syncQueue, clearQueue }}
    >
      {children}
    </OfflineQueueContext.Provider>
  );
}
