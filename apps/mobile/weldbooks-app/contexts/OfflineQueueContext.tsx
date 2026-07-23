import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import api from '@/services/api';

const QUEUE_STORAGE_KEY = '@weldbooks/offline-queue';

interface QueueItem {
  id: string;
  type: 'expense' | 'document';
  data: Record<string, any>;
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

  // Load queue from storage on mount
  useEffect(() => {
    loadQueue();
  }, []);

  // Monitor connectivity
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      const online = state.isConnected ?? true;
      setIsOnline(online);

      // Auto-sync when coming back online
      if (online && queue.length > 0 && !syncingRef.current) {
        syncQueue();
      }
    });

    return () => unsubscribe();
  }, [queue.length]);

  const loadQueue = async () => {
    try {
      const stored = await AsyncStorage.getItem(QUEUE_STORAGE_KEY);
      if (stored) {
        setQueue(JSON.parse(stored));
      }
    } catch (err) {
      console.error('Failed to load offline queue:', err);
    }
  };

  const saveQueue = async (items: QueueItem[]) => {
    try {
      await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(items));
      setQueue(items);
    } catch (err) {
      console.error('Failed to save offline queue:', err);
    }
  };

  const addToQueue = useCallback(async (item: Omit<QueueItem, 'id' | 'createdAt'>) => {
    const newItem: QueueItem = {
      ...item,
      id: `oq_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      createdAt: new Date().toISOString(),
    };
    const newQueue = [...queue, newItem];
    await saveQueue(newQueue);
  }, [queue]);

  const syncQueue = useCallback(async () => {
    if (syncingRef.current || queue.length === 0) return;

    syncingRef.current = true;
    setIsSyncing(true);

    try {
      const result = await api.uploadOfflineQueue(
        queue.map(item => ({ type: item.type, data: item.data }))
      );

      if (result.data) {
        // Remove successfully processed items
        const failedIndices = new Set(
          (result.data.results || [])
            .filter((r: any) => r.error)
            .map((r: any) => r.index)
        );

        const remaining = queue.filter((_, i) => failedIndices.has(i));
        await saveQueue(remaining);
      }
    } catch (err) {
      console.error('Failed to sync offline queue:', err);
    } finally {
      syncingRef.current = false;
      setIsSyncing(false);
    }
  }, [queue]);

  const clearQueue = useCallback(async () => {
    await saveQueue([]);
  }, []);

  return (
    <OfflineQueueContext.Provider value={{ queue, isOnline, isSyncing, addToQueue, syncQueue, clearQueue }}>
      {children}
    </OfflineQueueContext.Provider>
  );
}
