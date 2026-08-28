import type { DeskApiConversation, DeskApiMessage, Message, WidgetConfigResponse } from './types';
import { getOrCreateVisitorId } from '../utils/customer-storage';

const API_URL = import.meta.env.VITE_WIDGET_API_URL || 'http://localhost:8787';

function headers(widgetId: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'x-widget-id': widgetId,
  };
}

export function mapApiMessage(row: DeskApiMessage): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    content: row.body ?? '',
    sender: row.authorType === 'visitor' ? 'user' : 'agent',
    timestamp: new Date(row.createdAt),
    senderId: row.authorId ?? undefined,
    senderName: row.authorType === 'visitor' ? 'You' : row.authorType === 'bot' ? 'Bot' : 'Agent',
    attachments: (row.attachments ?? []).map((a) => ({
      name: a.name,
      url: a.url,
      mimeType: a.contentType,
      fileSize: a.filesize,
    })),
    metadata: row.kind === 'event' ? { systemEvent: true } : undefined,
  };
}

async function parse<T>(res: Response): Promise<T> {
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(json.error?.message || `Request failed (${res.status})`);
  }
  return json.data as T;
}

export const widgetApi = {
  async getConfig(widgetId: string): Promise<WidgetConfigResponse> {
    const res = await fetch(`${API_URL}/api/config`, { headers: headers(widgetId) });
    return parse<WidgetConfigResponse>(res);
  },

  async identify(widgetId: string, visitor: { visitorId: string; name?: string; email?: string }) {
    const res = await fetch(`${API_URL}/api/conversations/identify`, {
      method: 'POST',
      headers: headers(widgetId),
      body: JSON.stringify(visitor),
    });
    return parse<{ visitor: { id: string; name: string | null; email: string | null }; conversationId: string | null }>(res);
  },

  async startConversation(widgetId: string, input: { visitorId: string; name?: string; email?: string; body: string }) {
    const res = await fetch(`${API_URL}/api/conversations`, {
      method: 'POST',
      headers: headers(widgetId),
      body: JSON.stringify(input),
    });
    return parse<{ conversation: DeskApiConversation; messages: DeskApiMessage[] }>(res);
  },

  async getConversation(widgetId: string, conversationId: string, visitorId: string) {
    const res = await fetch(
      `${API_URL}/api/conversations/${conversationId}?visitorId=${encodeURIComponent(visitorId)}`,
      { headers: headers(widgetId) },
    );
    return parse<DeskApiConversation>(res);
  },

  async sendMessage(widgetId: string, conversationId: string, visitorId: string, body: string) {
    const res = await fetch(`${API_URL}/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: headers(widgetId),
      body: JSON.stringify({ visitorId, body }),
    });
    return parse<{ conversation: DeskApiConversation; message: DeskApiMessage }>(res);
  },

  async realtimeToken(widgetId: string, visitorId: string, conversationId?: string) {
    const res = await fetch(`${API_URL}/api/realtime/token`, {
      method: 'POST',
      headers: headers(widgetId),
      body: JSON.stringify({ visitorId, conversationId }),
    });
    return parse<{ token: string }>(res);
  },

  async typing(widgetId: string, conversationId: string, isTyping: boolean, visitorName?: string) {
    await fetch(`${API_URL}/api/realtime/typing`, {
      method: 'POST',
      headers: headers(widgetId),
      body: JSON.stringify({ conversationId, isTyping, visitorName }),
    });
  },

  visitorId(): string {
    return getOrCreateVisitorId();
  },
};
