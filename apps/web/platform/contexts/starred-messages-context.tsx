
import { createContext, useContext, useState, ReactNode, useCallback } from 'react';

interface StarredMessagesContextType {
  starredMessages: Set<string>;
  isStarred: (messageId: string) => boolean;
  toggleStar: (messageId: string) => void;
  starMessage: (messageId: string) => void;
  unstarMessage: (messageId: string) => void;
}

const StarredMessagesContext = createContext<StarredMessagesContextType | undefined>(undefined);

export function StarredMessagesProvider({ children }: { children: ReactNode }) {
  const [starredMessages, setStarredMessages] = useState<Set<string>>(new Set());

  const isStarred = useCallback((messageId: string) => {
    return starredMessages.has(messageId);
  }, [starredMessages]);

  const toggleStar = useCallback((messageId: string) => {
    setStarredMessages(prev => {
      const newSet = new Set(prev);
      if (newSet.has(messageId)) {
        newSet.delete(messageId);
      } else {
        newSet.add(messageId);
      }
      return newSet;
    });
  }, []);

  const starMessage = useCallback((messageId: string) => {
    setStarredMessages(prev => new Set(prev).add(messageId));
  }, []);

  const unstarMessage = useCallback((messageId: string) => {
    setStarredMessages(prev => {
      const newSet = new Set(prev);
      newSet.delete(messageId);
      return newSet;
    });
  }, []);

  return (
    <StarredMessagesContext.Provider value={{ starredMessages, isStarred, toggleStar, starMessage, unstarMessage }}>
      {children}
    </StarredMessagesContext.Provider>
  );
}

// Safe version that returns null if provider is missing
export function useStarredMessagesSafe() {
  return useContext(StarredMessagesContext);
}
