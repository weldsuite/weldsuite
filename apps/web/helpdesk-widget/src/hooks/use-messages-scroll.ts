/**
 * Hook for managing messages scroll behavior
 */

import { useRef, useCallback } from 'react';

export function useMessagesScroll() {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  return {
    messagesEndRef,
    scrollToBottom,
  };
}
