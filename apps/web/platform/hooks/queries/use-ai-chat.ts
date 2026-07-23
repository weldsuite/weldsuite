/**
 * WeldAgent chat — client state + streaming send.
 *
 * Holds the in-memory conversation for one open of the agent panel and streams
 * the assistant reply token-by-token from `POST /api/ai/chat/stream` (the server
 * is stateless and routes through the Cloudflare AI Gateway). No persistence —
 * closing the panel / starting a new conversation clears it.
 *
 * Streaming can't go through the typed app-api client (it parses JSON), so this
 * does a direct `fetch` with the Clerk token and reads the `text/plain` body
 * incrementally.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';

const APP_API_URL = import.meta.env.VITE_APP_API_URL || 'http://localhost:8789';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

/** `credits` → wallet empty (402); `generic` → anything else. */
export type ChatError = 'credits' | 'generic' | null;

interface UseWeldAgentChatOptions {
  /** Extra system context (e.g. the entity the user is viewing). */
  system?: string;
  /** Canonical model id override; server defaults to the free copilot model. */
  model?: string;
  /**
   * Messages to seed the conversation with (e.g. history loaded for a saved
   * chat). Applied whenever the array identity changes, so pass a stable
   * (memoized) reference to avoid clobbering an in-progress conversation.
   */
  initialMessages?: ChatMessage[];
  /**
   * Fired when the user sends a message (before streaming). Use to persist the
   * turn. Runs fire-and-forget; a rejection is swallowed so chat keeps working
   * even if saving fails.
   */
  onUserMessage?: (content: string) => void | Promise<void>;
  /**
   * Fired once the assistant reply has fully streamed in. Use to persist it.
   * Runs fire-and-forget (see `onUserMessage`).
   */
  onAssistantMessage?: (content: string) => void | Promise<void>;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function useWeldAgentChat({
  system,
  model,
  initialMessages,
  onUserMessage,
  onAssistantMessage,
}: UseWeldAgentChatOptions = {}) {
  const { getToken } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages ?? []);
  const [error, setError] = useState<ChatError>(null);
  const [isSending, setIsSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Keep the latest persistence callbacks without re-creating streamTurn.
  const onUserMessageRef = useRef(onUserMessage);
  const onAssistantMessageRef = useRef(onAssistantMessage);
  onUserMessageRef.current = onUserMessage;
  onAssistantMessageRef.current = onAssistantMessage;

  // Seed / re-seed when loaded history arrives (e.g. opening a saved chat).
  useEffect(() => {
    if (initialMessages) setMessages(initialMessages);
  }, [initialMessages]);

  /** Stream one turn. `history` already includes the triggering user message. */
  const streamTurn = useCallback(
    async (history: ChatMessage[]) => {
      setError(null);
      setIsSending(true);
      const assistantId = newId();
      // Add the assistant bubble up front so it can fill in as tokens arrive.
      setMessages((prev) => [...prev, { id: assistantId, role: 'assistant', content: '' }]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const token = await getToken();
        const res = await fetch(`${APP_API_URL}/api/ai/chat/stream`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            messages: history.map((m) => ({ role: m.role, content: m.content })),
            system,
            model,
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          setError(res.status === 402 ? 'credits' : 'generic');
          // Drop the empty assistant bubble on a failed open.
          setMessages((prev) => prev.filter((m) => m.id !== assistantId));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: acc } : m)),
          );
        }
        acc += decoder.decode();
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: acc } : m)));

        // Empty completion with no error → surface it rather than a blank bubble.
        if (!acc.trim()) {
          setError('generic');
          setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        } else {
          // Persist the completed assistant turn (fire-and-forget).
          void Promise.resolve(onAssistantMessageRef.current?.(acc)).catch(() => {});
        }
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        setError('generic');
        setMessages((prev) => prev.filter((m) => m.id !== assistantId || m.content.length > 0));
      } finally {
        setIsSending(false);
        abortRef.current = null;
      }
    },
    [getToken, model, system],
  );

  const sendMessage = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || isSending) return;
      const history = [...messages, { id: newId(), role: 'user' as const, content: text }];
      setMessages(history);
      // Persist the user turn (fire-and-forget) before streaming the reply.
      void Promise.resolve(onUserMessageRef.current?.(text)).catch(() => {});
      void streamTurn(history);
    },
    [isSending, messages, streamTurn],
  );

  /** Re-send after an error: the failed assistant bubble was already dropped, so
   *  the conversation still ends with the last user turn. */
  const retry = useCallback(() => {
    if (isSending) return;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    void streamTurn(messages);
  }, [isSending, messages, streamTurn]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setIsSending(false);
  }, []);

  return { messages, sendMessage, retry, reset, isSending, error };
}
