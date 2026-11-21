import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';

/**
 * What a chat lets its visuals do. A chat that wraps its thread in a provider
 * with `ask` gets "Ask about this" on bars, slices, rows and tiles: it puts a
 * follow-up in the composer for the user to send. Without a provider (the
 * gallery, a read-only log) the visuals only expand and download.
 */
export interface ChatVisualActions {
  ask?: (prompt: string) => void;
  /**
   * The records are samples (the gallery): record cards neither look up the
   * current title nor open, since the records don't exist and would show as
   * deleted.
   */
  sampleRecords?: boolean;
}

const ChatVisualActionsContext = createContext<ChatVisualActions>({});

export function ChatVisualActionsProvider({
  ask,
  sampleRecords,
  children,
}: Readonly<ChatVisualActions & { children: ReactNode }>) {
  const value = useMemo(() => ({ ask, sampleRecords }), [ask, sampleRecords]);
  return <ChatVisualActionsContext.Provider value={value}>{children}</ChatVisualActionsContext.Provider>;
}

export function useChatVisualActions(): ChatVisualActions {
  return useContext(ChatVisualActionsContext);
}

/**
 * `ask` for a chat whose composer is a controlled text field: it sets the
 * text and puts the cursor at its end. Attach `composerRef` to an element
 * around the composer.
 */
export function usePrefillComposer(setValue: (value: string) => void) {
  const composerRef = useRef<HTMLDivElement>(null);
  const ask = useCallback(
    (prompt: string) => {
      setValue(prompt);
      requestAnimationFrame(() => {
        const field = composerRef.current?.querySelector<HTMLTextAreaElement | HTMLElement>(
          'textarea, [contenteditable="true"]',
        );
        field?.focus();
        if (field instanceof HTMLTextAreaElement) field.setSelectionRange(field.value.length, field.value.length);
      });
    },
    [setValue],
  );
  return { ask, composerRef };
}
