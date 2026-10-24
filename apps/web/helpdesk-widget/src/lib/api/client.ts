import type { MessageAttachment, PublicConversation, PublicMessage, WidgetConfigResponse } from './types';

const API_URL = import.meta.env.VITE_WIDGET_API_URL || 'http://localhost:8787';

export class WidgetApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WidgetApiError';
  }
}

async function request<T>(widgetId: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      // A multipart body needs the browser to set the boundary itself.
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      'x-widget-id': widgetId,
      ...init?.headers,
    },
  });
  let json: { success?: boolean; data?: T; error?: { message?: string } } = {};
  try {
    json = await res.json();
  } catch {
    // non-JSON error page
  }
  if (!res.ok || json.success === false) {
    throw new WidgetApiError(json.error?.message || `Request failed (${res.status})`, res.status);
  }
  return json.data as T;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const widgetApi = {
  getConfig(widgetId: string) {
    return request<WidgetConfigResponse>(widgetId, '/api/config');
  },

  identify(widgetId: string, visitor: { visitorId: string; name?: string; email?: string }) {
    return request<{ visitor: { id: string; name: string | null; email: string | null } }>(
      widgetId,
      '/api/conversations/identify',
      post(visitor),
    );
  },

  listConversations(widgetId: string, visitorId: string) {
    return request<PublicConversation[]>(
      widgetId,
      `/api/conversations?visitorId=${encodeURIComponent(visitorId)}`,
    );
  },

  getConversation(widgetId: string, conversationId: string, visitorId: string) {
    return request<{ conversation: PublicConversation; messages: PublicMessage[] }>(
      widgetId,
      `/api/conversations/${encodeURIComponent(conversationId)}?visitorId=${encodeURIComponent(visitorId)}`,
    );
  },

  startConversation(
    widgetId: string,
    input: { visitorId: string; name?: string; email?: string; body: string; clientId?: string },
  ) {
    return request<{ conversation: PublicConversation; message: PublicMessage }>(
      widgetId,
      '/api/conversations',
      post(input),
    );
  },

  sendMessage(
    widgetId: string,
    conversationId: string,
    input: { visitorId: string; body?: string; attachments?: MessageAttachment[]; clientId?: string },
  ) {
    return request<{ conversation: PublicConversation; message: PublicMessage }>(
      widgetId,
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      post(input),
    );
  },

  rateConversation(
    widgetId: string,
    conversationId: string,
    input: { visitorId: string; rating: number; comment?: string },
  ) {
    return request<{ conversation: PublicConversation; message: PublicMessage }>(
      widgetId,
      `/api/conversations/${encodeURIComponent(conversationId)}/rating`,
      post(input),
    );
  },

  /** Upload a file into a conversation the visitor owns; the result is what `sendMessage` takes as an attachment. */
  async uploadAttachment(
    widgetId: string,
    input: { conversationId: string; visitorId: string; file: File },
  ): Promise<MessageAttachment> {
    const form = new FormData();
    form.append('file', input.file);
    form.append('conversationId', input.conversationId);
    form.append('visitorId', input.visitorId);
    const uploaded = await request<{ url: string; fileName: string; fileSize: number; mimeType: string }>(
      widgetId,
      '/api/attachments/upload',
      { method: 'POST', body: form },
    );
    return {
      name: uploaded.fileName,
      url: uploaded.url,
      contentType: uploaded.mimeType,
      filesize: uploaded.fileSize,
    };
  },

  realtimeToken(widgetId: string, visitorId: string, conversationId: string) {
    return request<{ token: string; expiresIn: number }>(
      widgetId,
      '/api/realtime/token',
      post({ visitorId, conversationId }),
    );
  },
};

/** The API refuses every call for a widget its owner has switched off (403 "Widget is disabled"). */
export function isWidgetDisabledError(err: unknown): boolean {
  return err instanceof WidgetApiError && err.status === 403 && /disabled/i.test(err.message);
}
