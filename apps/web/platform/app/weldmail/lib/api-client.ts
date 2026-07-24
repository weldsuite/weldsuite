/**
 * Façade over the unified app-api (`apps/workers/app-api`).
 *
 * The 10-or-so weldmail components that use `mailApi.*` directly (compose
 * dialogs, message-detail, message-list, sidebar items, etc.) pre-date
 * the `useAppApi()` hook layer, so refactoring every call site into a
 * hook-shaped pattern would be a much wider change. Instead this file
 * keeps the legacy `mailApi.*` surface + the `ApiResponse<T>` envelope
 * intact, but rewrites the internals to call the new app-api routes.
 *
 * Concretely: every `fetchApi` call now hits `/api/mail-{accounts,
 * messages, labels, drafts, scheduled}/*` on `VITE_APP_API_URL` instead
 * of the legacy `/api/mail/*` on the obsolete api-worker, and unwraps the
 * `{ data, pagination? }` envelope into the legacy `ApiResponse<T>`
 * shape callers already destructure.
 *
 * AI endpoints (`mailApi.ai.*`) now route through app-api `mail-ai`,
 * which proxies to agent-worker `/dispatch/mail-ai/*`.
 */

import type { Mail } from '@/lib/api/types/apps/mail.types';

const APP_API_URL = import.meta.env.VITE_APP_API_URL || 'http://localhost:8789';

const APP_BASE = `${APP_API_URL}/api`;

/**
 * Standard response shape every `mailApi.*` method returns. The platform
 * components already destructure `result.success` / `result.data` /
 * `result.error` against this; keeping it stable means zero call-site
 * changes during the migration.
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  /** Structured backend error code (e.g. `INVALID_RECIPIENTS`). */
  errorCode?: string;
  /** Whatever shape the backend attached. */
  errorDetails?: unknown;
}

async function getAuthToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const clerk = (window as unknown as { Clerk?: { session?: { getToken: () => Promise<string | null> } } }).Clerk;
  return clerk?.session ? clerk.session.getToken() : null;
}

interface AppApiSuccess<T> {
  /** Single-item envelope shape. */
  data: T;
}
interface AppApiError {
  error: { code: string; message: string; details?: unknown };
}

/**
 * Core request helper. `unwrap` strips the app-api `{ data }` envelope so
 * the legacy `ApiResponse<T>` shape stays unchanged; pass `unwrap: false`
 * to bubble the whole body up (used by endpoints that return a list with
 * pagination metadata callers want to read).
 */
async function request<T>(
  base: string,
  path: string,
  options: RequestInit & { unwrap?: boolean } = {},
): Promise<ApiResponse<T>> {
  const { unwrap = true, ...init } = options;
  try {
    const token = await getAuthToken();
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });

    // 204 No Content — `DELETE` routes on app-api don't return a body.
    if (response.status === 204) {
      return { success: true, data: { deleted: true } as unknown as T };
    }

    // Some upstream paths return text; guard the JSON parse so a stray
    // HTML error page doesn't take the whole hook down.
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      const raw = (body as AppApiError | { error?: string } | null)?.error;
      if (raw && typeof raw === 'object') {
        return {
          success: false,
          error: raw.message ?? 'Request failed',
          errorCode: typeof raw.code === 'string' ? raw.code : undefined,
          errorDetails: 'details' in raw ? raw.details : undefined,
        };
      }
      return {
        success: false,
        error: typeof raw === 'string' ? raw : (body as { message?: string })?.message ?? 'Request failed',
      };
    }

    if (!body) return { success: true, data: undefined as unknown as T };

    // Unwrap `{ data, pagination? }` → just `data` for the legacy
    // contract. Lists keep their array shape.
    if (unwrap && typeof body === 'object' && 'data' in (body as object)) {
      return { success: true, data: (body as AppApiSuccess<T>).data };
    }
    return { success: true, data: body as T };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}

function appApi<T>(path: string, options: RequestInit & { unwrap?: boolean } = {}) {
  return request<T>(APP_BASE, path, options);
}

/**
 * Sidebar-badge invalidation. Components listen on the
 * `mail-messages-changed` window event to refetch their counts.
 */
function notifyMessagesChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('mail-messages-changed'));
  }
}

async function mutate<T>(p: Promise<ApiResponse<T>>): Promise<ApiResponse<T>> {
  const result = await p;
  if (result.success) notifyMessagesChanged();
  return result;
}

function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const q = sp.toString();
  return q ? `?${q}` : '';
}

// ---------------------------------------------------------------------------
// Public types — kept as-is so call sites don't have to re-import.
// ---------------------------------------------------------------------------

export interface CreateLabelData {
  name: string;
  color?: string;
  aiEnabled?: boolean;
  aiKeywords?: string[];
  aiDescription?: string | null;
  aiConfidence?: number;
}

export interface UpdateLabelData {
  name?: string;
  color?: string;
  aiEnabled?: boolean;
  aiKeywords?: string[];
  aiDescription?: string | null;
  aiConfidence?: number;
}

export interface MessageFilters {
  labelName?: string;
  isRead?: boolean;
  isStarred?: boolean;
  limit?: number;
  offset?: number;
}

export interface UpdateMessageData {
  isRead?: boolean;
  isStarred?: boolean;
  isImportant?: boolean;
  labels?: string[];
}

export interface SyncResult {
  syncedMessages?: number;
}

export interface Draft {
  id: string;
  accountId: string;
  subject?: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: string[];
  body?: string | null;
  htmlBody?: string | null;
  importance?: string | null;
  labels: string[];
  hasAttachments?: boolean;
  attachmentCount?: number;
  inReplyTo?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDraftData {
  subject?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  body?: string;
  htmlBody?: string;
  importance?: string;
  labels?: string[];
  inReplyTo?: string;
}

export interface UpdateDraftData {
  subject?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  body?: string;
  htmlBody?: string;
  importance?: string;
  labels?: string[];
}

// ---------------------------------------------------------------------------
// Helpers shared by `messages.move/archive/spam/trash/restore`.
// ---------------------------------------------------------------------------

/**
 * Translate the legacy "move-to-folder" action into the corresponding
 * label add/remove + bulk action on the new app-api. The legacy
 * `/messages/:id/move` endpoint encoded folder transitions as a single
 * verb; on the new surface the same intent is composed.
 */
async function applyMessageMove(
  messageId: string,
  action: 'archive' | 'spam' | 'unspam' | 'inbox' | 'trash' | 'restore',
): Promise<ApiResponse<{ moved: boolean; fromFolder: string; toFolder: string; action: string }>> {
  switch (action) {
    case 'archive': {
      const add = await appApi<{ id: string; labels: string[] }>(
        `/mail-messages/${messageId}/labels/add`,
        { method: 'POST', body: JSON.stringify({ labels: ['ARCHIVE'] }) },
      );
      if (!add.success) return { success: false, error: add.error, errorCode: add.errorCode };
      await appApi(`/mail-messages/${messageId}/labels/remove`, {
        method: 'POST',
        body: JSON.stringify({ labels: ['INBOX'] }),
      });
      return { success: true, data: { moved: true, fromFolder: 'INBOX', toFolder: 'ARCHIVE', action } };
    }
    case 'inbox':
    case 'restore': {
      const add = await appApi<{ id: string; labels: string[] }>(
        `/mail-messages/${messageId}/labels/add`,
        { method: 'POST', body: JSON.stringify({ labels: ['INBOX'] }) },
      );
      if (!add.success) return { success: false, error: add.error, errorCode: add.errorCode };
      // Pull out of trash/archive on the way back to inbox.
      await appApi(`/mail-messages/${messageId}/labels/remove`, {
        method: 'POST',
        body: JSON.stringify({ labels: ['TRASH', 'ARCHIVE', 'SPAM'] }),
      });
      return { success: true, data: { moved: true, fromFolder: 'TRASH', toFolder: 'INBOX', action } };
    }
    case 'trash': {
      const bulk = await appApi<{ affected: number }>('/mail-messages/bulk', {
        method: 'POST',
        body: JSON.stringify({ messageIds: [messageId], action: 'trash' }),
      });
      if (!bulk.success) return { success: false, error: bulk.error, errorCode: bulk.errorCode };
      return { success: true, data: { moved: true, fromFolder: 'INBOX', toFolder: 'TRASH', action } };
    }
    case 'spam': {
      const update = await appApi<{ id: string }>(`/mail-messages/${messageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isSpam: true }),
      });
      if (!update.success) return { success: false, error: update.error, errorCode: update.errorCode };
      return { success: true, data: { moved: true, fromFolder: 'INBOX', toFolder: 'SPAM', action } };
    }
    case 'unspam': {
      const update = await appApi<{ id: string }>(`/mail-messages/${messageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isSpam: false }),
      });
      if (!update.success) return { success: false, error: update.error, errorCode: update.errorCode };
      return { success: true, data: { moved: true, fromFolder: 'SPAM', toFolder: 'INBOX', action } };
    }
  }
}

// ---------------------------------------------------------------------------
// Public surface — same shape, new endpoints.
// ---------------------------------------------------------------------------

export const mailApi = {
  accounts: {
    list: () => appApi<Mail.EmailAccount[]>('/mail-accounts', { unwrap: true }),

    get: (accountId: string) =>
      appApi<Mail.EmailAccount>(`/mail-accounts/${accountId}`),

    sync: async (accountId: string): Promise<ApiResponse<SyncResult>> => {
      const result = await appApi<{ id: string; syncStatus: string }>(
        `/mail-accounts/${accountId}/sync`,
        { method: 'PATCH', body: '{}' },
      );
      if (!result.success) {
        return { success: false, error: result.error, errorCode: result.errorCode };
      }
      // app-api kicks off the sync; the actual message count is
      // out-of-band, so report 0 here. The badge listener picks up the
      // real numbers from `mail-messages-changed`.
      return { success: true, data: { syncedMessages: 0 } };
    },
  },

  messages: {
    list: (accountId: string, filters?: MessageFilters) => {
      const q = buildQuery({
        accountId,
        label: filters?.labelName,
        isRead: filters?.isRead,
        isStarred: filters?.isStarred,
        limit: filters?.limit,
      });
      // List response keeps its full envelope so callers can see
      // pagination if they want; the unwrapper only takes `.data`.
      return appApi<Mail.Email[]>(`/mail-messages${q}`);
    },

    get: (_accountId: string, messageId: string) =>
      appApi<Mail.Email>(`/mail-messages/${messageId}`),

    update: (_accountId: string, messageId: string, data: UpdateMessageData) =>
      mutate(
        appApi<Mail.Email>(`/mail-messages/${messageId}`, {
          method: 'PATCH',
          body: JSON.stringify(data),
        }),
      ),

    delete: (_accountId: string, messageId: string) =>
      mutate(
        appApi<{ deleted: boolean }>(`/mail-messages/${messageId}`, { method: 'DELETE' }),
      ),

    addLabel: (_accountId: string, messageId: string, labelName: string) =>
      mutate(
        appApi<Mail.Email>(`/mail-messages/${messageId}/labels/add`, {
          method: 'POST',
          body: JSON.stringify({ labels: [labelName] }),
        }),
      ),

    removeLabel: (_accountId: string, messageId: string, labelName: string) =>
      mutate(
        appApi<Mail.Email>(`/mail-messages/${messageId}/labels/remove`, {
          method: 'POST',
          body: JSON.stringify({ labels: [labelName] }),
        }),
      ),

    reply: (
      _accountId: string,
      messageId: string,
      data: { body: string; htmlBody?: string; replyAll?: boolean },
    ) =>
      mutate(
        appApi<{ messageId: string; smtpMessageId: string; pendingVerification: boolean; repliedTo: string }>(
          `/mail-messages/${messageId}/reply`,
          { method: 'POST', body: JSON.stringify(data) },
        ),
      ),

    forward: (
      _accountId: string,
      messageId: string,
      data: { to: string[]; body?: string; htmlBody?: string },
    ) =>
      mutate(
        appApi<{ messageId: string; smtpMessageId: string; pendingVerification: boolean; forwardedFrom: string }>(
          `/mail-messages/${messageId}/forward`,
          { method: 'POST', body: JSON.stringify(data) },
        ),
      ),

    send: (
      accountId: string,
      data: {
        to: string[];
        cc?: string[];
        bcc?: string[];
        subject?: string;
        body?: string;
        htmlBody?: string;
        replyTo?: string;
        inReplyTo?: string;
        references?: string[];
        importance?: 'low' | 'normal' | 'high';
        attachmentIds?: string[];
        attachments?: Array<{
          filename: string;
          contentType?: string;
          size: number;
          fileKey: string;
        }>;
      },
    ) =>
      mutate(
        appApi<{ messageId: string; smtpMessageId?: string; message: string; pendingVerification?: boolean }>(
          `/mail-accounts/${accountId}/send`,
          { method: 'POST', body: JSON.stringify(data) },
        ),
      ),

    move: (
      _accountId: string,
      messageId: string,
      action: 'archive' | 'spam' | 'unspam' | 'inbox' | 'trash' | 'restore',
    ) => mutate(applyMessageMove(messageId, action)),

    archive: (_accountId: string, messageId: string) =>
      mutate(applyMessageMove(messageId, 'archive')).then(toMoved),
    spam: (_accountId: string, messageId: string, isSpam = true) =>
      mutate(applyMessageMove(messageId, isSpam ? 'spam' : 'unspam')).then(toMoved),
    trash: (_accountId: string, messageId: string) =>
      mutate(applyMessageMove(messageId, 'trash')).then(toMoved),
    restore: (_accountId: string, messageId: string) =>
      mutate(applyMessageMove(messageId, 'restore')).then(toMoved),

    /**
     * Stats. app-api returns `{ total, unread, inboxUnread, starred }` —
     * the legacy shape had more breakdowns (sent/spam/scheduled/etc).
     * We fill those with 0 here so the inbox UI doesn't NaN; richer
     * counts can land when the stats endpoint grows.
     */
    stats: async (accountId: string) => {
      const result = await appApi<{ total: number; unread: number; inboxUnread: number; starred: number }>(
        `/mail-messages/stats${buildQuery({ accountId })}`,
      );
      if (!result.success || !result.data) {
        return {
          success: result.success,
          error: result.error,
          errorCode: result.errorCode,
          errorDetails: result.errorDetails,
        } as ApiResponse<{
          total: number; unread: number; inboxUnread: number; starredUnread: number;
          sentUnread: number; drafts: number; spam: number; trashUnread: number;
          snoozed: number; scheduled: number; importantUnread: number; archiveUnread: number;
        }>;
      }
      return {
        success: true as const,
        data: {
          total: result.data.total,
          unread: result.data.unread,
          inboxUnread: result.data.inboxUnread,
          starredUnread: result.data.starred,
          sentUnread: 0,
          drafts: 0,
          spam: 0,
          trashUnread: 0,
          snoozed: 0,
          scheduled: 0,
          importantUnread: 0,
          archiveUnread: 0,
        },
      };
    },
  },

  labels: {
    list: (accountId: string) =>
      appApi<Mail.Label[]>(`/mail-labels${buildQuery({ accountId })}`),

    get: (_accountId: string, labelId: string) =>
      appApi<Mail.Label>(`/mail-labels/${labelId}`),

    create: (accountId: string, data: CreateLabelData) =>
      appApi<Mail.Label>('/mail-labels', {
        method: 'POST',
        body: JSON.stringify({ accountId, ...data }),
      }),

    update: (_accountId: string, labelId: string, data: UpdateLabelData) =>
      appApi<Mail.Label>(`/mail-labels/${labelId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),

    delete: (_accountId: string, labelId: string) =>
      appApi<{ deleted: boolean }>(`/mail-labels/${labelId}`, { method: 'DELETE' }),
  },

  unified: {
    threads: (
      labelSlug: string,
      { page, pageSize }: { page: number; pageSize: number },
    ) =>
      appApi<{ threads: unknown[]; totalCount: number }>(
        `/mail-labels/threads${buildQuery({ labelSlug, page, pageSize })}`,
      ),
  },

  ai: {
    // Now routed through app-api `mail-ai`, which proxies to
    // agent-worker `/dispatch/mail-ai/*`. agent-worker returns the
    // legacy `{ success, data }` envelope, so the request helper
    // unwraps `.data` and the call sites see `result.data.labels`
    // exactly as before.
    assignLabels: (_accountId: string, messageId: string) =>
      appApi<{ labels: string[]; skippedAI?: boolean }>('/mail-ai/label', {
        method: 'POST',
        body: JSON.stringify({ messageId }),
      }),

    assignLabelsToMultiple: (_accountId: string, messageIds: string[]) =>
      appApi<{ processed: number; labeled: number }>('/mail-ai/label/batch', {
        method: 'POST',
        body: JSON.stringify({ messageIds }),
      }),
  },

  drafts: {
    list: (accountId: string) =>
      appApi<Draft[]>(`/mail-drafts${buildQuery({ accountId })}`),

    get: (_accountId: string, draftId: string) =>
      appApi<Draft>(`/mail-drafts/${draftId}`),

    create: (accountId: string, data: CreateDraftData) =>
      appApi<Draft>('/mail-drafts', {
        method: 'POST',
        body: JSON.stringify({ accountId, ...data }),
      }),

    update: (_accountId: string, draftId: string, data: UpdateDraftData) =>
      appApi<Draft>(`/mail-drafts/${draftId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),

    delete: (_accountId: string, draftId: string) =>
      appApi<{ deleted: boolean }>(`/mail-drafts/${draftId}`, { method: 'DELETE' }),

    /**
     * Compose-then-send a draft: read it, post via mail-accounts.send,
     * then delete the draft row. There's no dedicated app-api endpoint
     * because the same flow is one helper hop here.
     */
    send: async (
      accountId: string,
      draftId: string,
    ): Promise<ApiResponse<{ messageId: string; sent: boolean }>> => {
      const draft = await appApi<Draft>(`/mail-drafts/${draftId}`);
      if (!draft.success || !draft.data) {
        return { success: false, error: draft.error ?? 'Draft not found', errorCode: draft.errorCode };
      }
      const send = await appApi<{ messageId: string }>(
        `/mail-accounts/${accountId}/send`,
        {
          method: 'POST',
          body: JSON.stringify({
            to: draft.data.to,
            cc: draft.data.cc.length ? draft.data.cc : undefined,
            bcc: draft.data.bcc.length ? draft.data.bcc : undefined,
            subject: draft.data.subject ?? undefined,
            body: draft.data.body ?? undefined,
            htmlBody: draft.data.htmlBody ?? undefined,
          }),
        },
      );
      if (!send.success || !send.data) {
        return { success: false, error: send.error ?? 'Send failed', errorCode: send.errorCode };
      }
      // Best-effort delete — if it fails the draft just lingers, the
      // user can clear it manually.
      await appApi(`/mail-drafts/${draftId}`, { method: 'DELETE' });
      notifyMessagesChanged();
      return { success: true, data: { messageId: send.data.messageId, sent: true } };
    },
  },

  scheduled: {
    schedule: (data: {
      accountId: string;
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      body?: string;
      htmlBody?: string;
      replyTo?: string;
      importance?: 'low' | 'normal' | 'high';
      attachmentIds?: string[];
      /** Freshly-uploaded R2 objects, same shape `messages.send` accepts.
       *  The route takes either this or `attachmentIds`. */
      attachments?: Array<{
        filename: string;
        contentType?: string;
        size: number;
        fileKey: string;
      }>;
      scheduledFor: Date;
      inReplyTo?: string;
      references?: string[];
    }) =>
      appApi<{ messageId: string; scheduledFor: string; triggerRunId: string }>('/mail-scheduled', {
        method: 'POST',
        body: JSON.stringify({ ...data, scheduledFor: data.scheduledFor.toISOString() }),
      }),

    list: (accountId?: string) =>
      appApi<unknown[]>(`/mail-scheduled${buildQuery({ accountId })}`),

    cancel: (messageId: string) =>
      appApi<{ id: string }>(`/mail-scheduled/${messageId}/cancel`, {
        method: 'POST',
        body: '{}',
      }),

    sendNow: (messageId: string) =>
      appApi<{ id: string; externalMessageId: string }>(
        `/mail-scheduled/${messageId}/send-now`,
        { method: 'POST', body: '{}' },
      ),

    reschedule: (messageId: string, scheduledFor: Date) =>
      appApi<{ scheduledFor: string; triggerRunId: string }>(
        `/mail-scheduled/${messageId}/reschedule`,
        {
          method: 'POST',
          body: JSON.stringify({ scheduledFor: scheduledFor.toISOString() }),
        },
      ),
  },
};

/**
 * Strip the full `move` payload down to `{ moved }` for the legacy
 * helper variants that historically only surfaced that flag.
 */
function toMoved(
  result: ApiResponse<{ moved: boolean; fromFolder: string; toFolder: string; action: string }>,
): ApiResponse<{ moved: boolean }> {
  if (!result.success || !result.data) {
    return { success: result.success, error: result.error, errorCode: result.errorCode };
  }
  return { success: true, data: { moved: result.data.moved } };
}

/**
 * Unified label-slug fetcher — backs sidebar navigation. System labels
 * (`INBOX`, `SENT`, …) and user labels go through the same endpoint;
 * the backend resolves the slug to a JSONB containment predicate.
 */
export async function fetchMessagesByLabelSlug(
  accountId: string,
  labelSlug: string,
  options?: { limit?: number; offset?: number },
): Promise<ApiResponse<Mail.Email[]>> {
  return mailApi.messages.list(accountId, {
    labelName: labelSlug,
    limit: options?.limit,
    offset: options?.offset,
  });
}
