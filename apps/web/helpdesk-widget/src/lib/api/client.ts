import type { DeskVisitorSession } from '@weldsuite/app-api-client/schemas/desk-portal';
import type { MessageAttachment, PublicConversation, PublicMessage, WidgetConfigResponse } from './types';

const API_URL = import.meta.env.VITE_WIDGET_API_URL || 'http://localhost:8787';

export class WidgetApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The API's error code (`IDENTITY_REQUIRED`, `VISITOR_TOKEN_INVALID`, …), when it sent one. */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'WidgetApiError';
  }
}

/** Body of `POST /api/visitor` (`deskVisitorSessionRequestSchema`). */
export interface VisitorSessionRequest {
  identityToken?: string;
  visitorToken?: string;
  legacyVisitorId?: string;
}

export type SessionVisitor = DeskVisitorSession['visitor'];

async function request<T>(widgetId: string, path: string, init?: RequestInit, visitorToken?: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      // A multipart body needs the browser to set the boundary itself.
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      'x-widget-id': widgetId,
      ...(visitorToken ? { Authorization: `Bearer ${visitorToken}` } : {}),
      ...init?.headers,
    },
  });
  let json: { success?: boolean; data?: T; error?: { code?: string; message?: string } } = {};
  try {
    json = await res.json();
  } catch {
    // non-JSON error page
  }
  if (!res.ok || json.success === false) {
    throw new WidgetApiError(
      json.error?.message || `Request failed (${res.status})`,
      res.status,
      json.error?.code ?? null,
    );
  }
  return json.data as T;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/** Calls that need no visitor: the widget's config and starting a visitor session. */
export const widgetApi = {
  getConfig(widgetId: string) {
    return request<WidgetConfigResponse>(widgetId, '/api/config');
  },

  /** Exchange an identity token / held visitor token / legacy id for a visitor token. */
  startSession(widgetId: string, body: VisitorSessionRequest) {
    return request<DeskVisitorSession>(widgetId, '/api/visitor', post(body));
  },
};

/** What the visitor API needs from the session (see lib/visitor-session). */
export interface VisitorAuth {
  readonly widgetId: string;
  /** The current visitor token, starting a session first when there is none. */
  getToken(): Promise<string>;
  /** The API refused `stale`: drop it and start a new session, once. */
  renew(stale: string): Promise<string>;
  /** The API says this widget only talks to signed-in users. */
  markIdentityRequired(): void;
}

const isApiError = (err: unknown, code: string) =>
  err instanceof WidgetApiError && err.status === 401 && err.code === code;

export function isIdentityRequiredError(err: unknown): boolean {
  return isApiError(err, 'IDENTITY_REQUIRED');
}

export function isIdentityInvalidError(err: unknown): boolean {
  return isApiError(err, 'IDENTITY_INVALID');
}

/**
 * The visitor's own routes. Every call carries the visitor token as a Bearer;
 * a token the API no longer accepts is replaced by a new session and the call
 * retried once.
 */
export function createVisitorApi(auth: VisitorAuth) {
  const { widgetId } = auth;

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await auth.getToken();
    try {
      return await request<T>(widgetId, path, init, token);
    } catch (err) {
      if (isIdentityRequiredError(err)) auth.markIdentityRequired();
      if (!isApiError(err, 'VISITOR_TOKEN_INVALID') && !isApiError(err, 'VISITOR_TOKEN_REQUIRED')) throw err;
      const fresh = await auth.renew(token);
      try {
        return await request<T>(widgetId, path, init, fresh);
      } catch (retryErr) {
        if (isIdentityRequiredError(retryErr)) auth.markIdentityRequired();
        throw retryErr;
      }
    }
  }

  return {
    /** Name / email the visitor typed. A verified visitor keeps the email that was proven. */
    identify(input: { name?: string; email?: string }) {
      return call<{ visitor: SessionVisitor }>('/api/conversations/identify', post(input));
    },

    listConversations() {
      return call<PublicConversation[]>('/api/conversations');
    },

    getConversation(conversationId: string) {
      return call<{ conversation: PublicConversation; messages: PublicMessage[] }>(
        `/api/conversations/${encodeURIComponent(conversationId)}`,
      );
    },

    startConversation(input: { name?: string; email?: string; body: string; clientId?: string }) {
      return call<{ conversation: PublicConversation; message: PublicMessage }>('/api/conversations', post(input));
    },

    sendMessage(
      conversationId: string,
      input: { body?: string; attachments?: MessageAttachment[]; clientId?: string },
    ) {
      return call<{ conversation: PublicConversation; message: PublicMessage }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        post(input),
      );
    },

    rateConversation(conversationId: string, input: { rating: number; comment?: string }) {
      return call<{ conversation: PublicConversation; message: PublicMessage }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/rating`,
        post(input),
      );
    },

    /** Upload a file into a conversation the visitor may see; the result is what `sendMessage` takes as an attachment. */
    async uploadAttachment(input: { conversationId: string; file: File }): Promise<MessageAttachment> {
      const form = new FormData();
      form.append('file', input.file);
      form.append('conversationId', input.conversationId);
      const uploaded = await call<{ url: string; fileName: string; fileSize: number; mimeType: string }>(
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

    realtimeToken(conversationId: string) {
      return call<{ token: string; expiresIn: number }>('/api/realtime/token', post({ conversationId }));
    },
  };
}

export type VisitorApi = ReturnType<typeof createVisitorApi>;

/** The API refuses every call for a widget its owner has switched off (403 "Widget is disabled"). */
export function isWidgetDisabledError(err: unknown): boolean {
  return err instanceof WidgetApiError && err.status === 403 && /disabled/i.test(err.message);
}
