
import { createContext, useContext, useState, ReactNode, useCallback } from 'react';

interface PinnedMessagesContextType {
  pinnedMessages: Set<string>;
  isPinned: (messageId: string) => boolean;
  togglePin: (messageId: string) => void;
  pinMessage: (messageId: string) => void;
  unpinMessage: (messageId: string) => void;
}

const PinnedMessagesContext = createContext<PinnedMessagesContextType | undefined>(undefined);

export function PinnedMessagesProvider({ children }: { children: ReactNode }) {
  const [pinnedMessages, setPinnedMessages] = useState<Set<string>>(new Set());

  const isPinned = useCallback((messageId: string) => {
    return pinnedMessages.has(messageId);
  }, [pinnedMessages]);

  const togglePin = useCallback((messageId: string) => {
    setPinnedMessages(prev => {
      const newSet = new Set(prev);
      if (newSet.has(messageId)) {
        newSet.delete(messageId);
      } else {
        newSet.add(messageId);
      }
      return newSet;
    });
  }, []);

  const pinMessage = useCallback((messageId: string) => {
    setPinnedMessages(prev => new Set(prev).add(messageId));
  }, []);

  const unpinMessage = useCallback((messageId: string) => {
    setPinnedMessages(prev => {
      const newSet = new Set(prev);
      newSet.delete(messageId);
      return newSet;
    });
  }, []);

  return (
    <PinnedMessagesContext.Provider value={{ pinnedMessages, isPinned, togglePin, pinMessage, unpinMessage }}>
      {children}
    </PinnedMessagesContext.Provider>
  );
}

function usePinnedMessages() {
  const context = useContext(PinnedMessagesContext);
  if (context === undefined) {
    throw new Error('usePinnedMessages must be used within a PinnedMessagesProvider');
  }
  return context;
}

// Safe version that returns null if provider is missing
export function usePinnedMessagesSafe() {
  return useContext(PinnedMessagesContext);
}
