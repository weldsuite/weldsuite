import { useCallback, useEffect, useRef, useState } from 'react';
import { RoomClient } from '@weldsuite/realtime/client';
import { widgetApi, mapApiMessage } from '@/lib/api/client';
import { getMostRecentConversationId, addConversationId } from '@/lib/utils/conversation-storage';
import { getOrCreateVisitorId, getOrCreateVisitorName } from '@/lib/utils/customer-storage';
import type { Message } from '@/lib/api/types';

const REALTIME_URL = import.meta.env.VITE_WIDGET_REALTIME_URL || '';

interface Options {
  widgetId: string;
  name?: string | null;
  email?: string | null;
  realtimeUrl?: string;
}

export function useConversation({ widgetId, name, email, realtimeUrl }: Options) {
  const visitorId = getOrCreateVisitorId();
  const visitorName = name || getOrCreateVisitorName();
  const [conversationId, setConversationId] = useState<string | null>(
    () => getMostRecentConversationId(widgetId),
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isClosed, setIsClosed] = useState(false);
  const [typing, setTyping] = useState(false);
  const clientRef = useRef<RoomClient | null>(null);

  const load = useCallback(async (id: string) => {
    setIsLoading(true);
    try {
      const conv = await widgetApi.getConversation(widgetId, id, visitorId);
      setConversationId(conv.id);
      setIsClosed(conv.state === 'closed');
      setMessages((conv.messages ?? []).filter((m) => m.kind !== 'note').map(mapApiMessage));
      addConversationId(widgetId, conv.id);
    } catch {
      setConversationId(null);
    } finally {
      setIsLoading(false);
    }
  }, [widgetId, visitorId]);

  useEffect(() => {
    if (conversationId) void load(conversationId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!conversationId || !REALTIME_URL && !realtimeUrl) return;
    const url = `${realtimeUrl || REALTIME_URL}/ws/conversation/${conversationId}`;
    const client = new RoomClient({
      url,
      getToken: async () => {
        const { token } = await widgetApi.realtimeToken(widgetId, visitorId, conversationId);
        return token;
      },
    });
    clientRef.current = client;
    const unsub = client.on('message', (event) => {
      if (event.type === 'typing') {
        setTyping(Boolean((event as { isTyping?: boolean }).isTyping));
        return;
      }
      if (event.type === 'system') {
        const ev = (event as { event?: string }).event;
        if (ev === 'closed') setIsClosed(true);
        if (ev === 'reopened') setIsClosed(false);
        void load(conversationId);
        return;
      }
      if (event.type === 'message' && (event as { senderType?: string }).senderType !== 'visitor') {
        void load(conversationId);
      }
    });
    client.connect();
    return () => {
      unsub();
      client.disconnect();
      clientRef.current = null;
    };
  }, [conversationId, widgetId, visitorId, realtimeUrl, load]);

  const send = useCallback(async (body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;

    if (!conversationId) {
      setIsCreating(true);
      try {
        const result = await widgetApi.startConversation(widgetId, {
          visitorId,
          name: visitorName,
          email: email || undefined,
          body: trimmed,
        });
        setConversationId(result.conversation.id);
        setIsClosed(result.conversation.state === 'closed');
        setMessages(result.messages.filter((m) => m.kind !== 'note').map(mapApiMessage));
        addConversationId(widgetId, result.conversation.id);
      } finally {
        setIsCreating(false);
      }
      return;
    }

    const optimistic: Message = {
      id: `tmp_${Date.now()}`,
      conversationId,
      content: trimmed,
      sender: 'user',
      timestamp: new Date(),
      senderName: 'You',
    };
    setMessages((prev) => [...prev, optimistic]);
    const result = await widgetApi.sendMessage(widgetId, conversationId, visitorId, trimmed);
    setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? mapApiMessage(result.message) : m)));
    setIsClosed(result.conversation.state === 'closed');
  }, [conversationId, widgetId, visitorId, visitorName, email]);

  const startTyping = useCallback(() => {
    if (conversationId) void widgetApi.typing(widgetId, conversationId, true, visitorName);
  }, [conversationId, widgetId, visitorName]);

  const stopTyping = useCallback(() => {
    if (conversationId) void widgetApi.typing(widgetId, conversationId, false, visitorName);
  }, [conversationId, widgetId, visitorName]);

  return {
    conversationId,
    messages,
    isLoading,
    isCreating,
    isClosed,
    typing,
    send,
    startTyping,
    stopTyping,
    visitorName,
  };
}
