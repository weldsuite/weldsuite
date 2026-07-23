/**
 * useMessages — Reducer-based message state management.
 *
 * Replaces 10+ setMessages(prev => ...) patterns with typed dispatch actions.
 * Handles deduplication, optimistic updates, AI streaming phantoms.
 */

import { useReducer, useCallback } from 'react';
import type { Message } from '@/lib/api/types';

// ============================================================================
// Actions
// ============================================================================

export type MessageAction =
  | { type: 'LOAD'; messages: Message[] }
  | { type: 'ADD'; message: Message }
  | { type: 'ADD_OPTIMISTIC'; message: Message }
  | { type: 'CONFIRM'; tempId: string; message: Message }
  | { type: 'REMOVE'; id: string }
  | { type: 'MARK_FAILED'; id: string }
  | { type: 'UPDATE'; id: string; updates: Partial<Message> }
  | { type: 'SET_STREAMING'; id: string; content: string }
  | { type: 'APPEND_CONTENT'; id: string; content: string }
  | { type: 'FINALIZE_STREAMING'; streamId: string; realId: string; content: string }
  | { type: 'CLEAR' };

// ============================================================================
// Reducer
// ============================================================================

function messagesReducer(state: Message[], action: MessageAction): Message[] {
  switch (action.type) {
    case 'LOAD':
      return action.messages;

    case 'ADD': {
      // Deduplicate by ID
      if (state.some((m) => m.id === action.message.id)) return state;
      return [...state, action.message];
    }

    case 'ADD_OPTIMISTIC': {
      // Add with isPending flag — ID starts with "temp-"
      if (state.some((m) => m.id === action.message.id)) return state;
      return [...state, action.message];
    }

    case 'CONFIRM': {
      // Replace optimistic message (temp-xxx) with real server message
      return state.map((m) =>
        m.id === action.tempId ? action.message : m,
      );
    }

    case 'REMOVE':
      return state.filter((m) => m.id !== action.id);

    case 'MARK_FAILED':
      return state.map((m) =>
        m.id === action.id
          ? { ...m, metadata: { ...(m.metadata || {}), sendFailed: true } }
          : m,
      );

    case 'UPDATE':
      return state.map((m) =>
        m.id === action.id ? { ...m, ...action.updates } : m,
      );

    case 'SET_STREAMING':
      return state.map((m) =>
        m.id === action.id ? { ...m, content: action.content } : m,
      );

    case 'APPEND_CONTENT':
      return state.map((m) =>
        m.id === action.id ? { ...m, content: (m.content || '') + action.content } : m,
      );

    case 'FINALIZE_STREAMING': {
      // Replace streaming-{messageId} with the real message
      return state.map((m) =>
        m.id === action.streamId
          ? {
              ...m,
              id: action.realId,
              content: action.content,
              metadata: {
                ...(m.metadata || {}),
                isStreaming: false,
              },
            }
          : m,
      );
    }

    case 'CLEAR':
      return [];

    default:
      return state;
  }
}

// ============================================================================
// Hook
// ============================================================================

export function useMessages(initialMessages: Message[] = []) {
  const [messages, dispatch] = useReducer(messagesReducer, initialMessages);

  // Convenience methods

  const loadMessages = useCallback((msgs: Message[]) => {
    dispatch({ type: 'LOAD', messages: msgs });
  }, []);

  const addMessage = useCallback((message: Message) => {
    dispatch({ type: 'ADD', message });
  }, []);

  const addOptimistic = useCallback((message: Message) => {
    dispatch({ type: 'ADD_OPTIMISTIC', message });
  }, []);

  const confirmMessage = useCallback((tempId: string, message: Message) => {
    dispatch({ type: 'CONFIRM', tempId, message });
  }, []);

  const removeMessage = useCallback((id: string) => {
    dispatch({ type: 'REMOVE', id });
  }, []);

  const markFailed = useCallback((id: string) => {
    dispatch({ type: 'MARK_FAILED', id });
  }, []);

  const updateMessage = useCallback((id: string, updates: Partial<Message>) => {
    dispatch({ type: 'UPDATE', id, updates });
  }, []);

  const setStreaming = useCallback((id: string, content: string) => {
    dispatch({ type: 'SET_STREAMING', id, content });
  }, []);

  const appendContent = useCallback((id: string, content: string) => {
    dispatch({ type: 'APPEND_CONTENT', id, content });
  }, []);

  const finalizeStreaming = useCallback(
    (streamId: string, realId: string, content: string) => {
      dispatch({ type: 'FINALIZE_STREAMING', streamId, realId, content });
    },
    [],
  );

  const clearMessages = useCallback(() => {
    dispatch({ type: 'CLEAR' });
  }, []);

  return {
    messages,
    dispatch,
    // Convenience methods
    loadMessages,
    addMessage,
    addOptimistic,
    confirmMessage,
    removeMessage,
    markFailed,
    updateMessage,
    setStreaming,
    appendContent,
    finalizeStreaming,
    clearMessages,
  };
}
