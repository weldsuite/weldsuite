import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'weldmail:pinnedMessages';

interface PinnedMessagesContextType {
  isPinned: (messageId: string) => boolean;
  togglePin: (messageId: string) => void;
}

const PinnedMessagesContext = createContext<PinnedMessagesContextType | undefined>(undefined);

/**
 * Pin is not persisted on the backend (mail_messages has no isPinned column),
 * so — like the web platform — pinned state lives client-side. Sharing it via
 * context keeps the inbox and the email detail page in sync, and AsyncStorage
 * lets pins survive app restarts.
 */
export function PinnedMessagesProvider({ children }: { children: ReactNode }) {
  const [pinned, setPinned] = useState<Set<string>>(new Set());

  // Hydrate from storage once on mount.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const ids: string[] = JSON.parse(raw);
          if (Array.isArray(ids)) setPinned(new Set(ids));
        }
      } catch {
        // ignore corrupt/missing storage
      }
    })();
  }, []);

  const persist = useCallback((next: Set<string>) => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...next])).catch(() => {});
  }, []);

  const isPinned = useCallback((messageId: string) => pinned.has(messageId), [pinned]);

  const togglePin = useCallback((messageId: string) => {
    setPinned(prev => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      persist(next);
      return next;
    });
  }, [persist]);

  return (
    <PinnedMessagesContext.Provider value={{ isPinned, togglePin }}>
      {children}
    </PinnedMessagesContext.Provider>
  );
}

export function usePinnedMessages() {
  const ctx = useContext(PinnedMessagesContext);
  if (!ctx) {
    throw new Error('usePinnedMessages must be used within a PinnedMessagesProvider');
  }
  return ctx;
}
