/**
 * Shared adapters for the app-api-backed facade modules (W1b phase-out).
 *
 * The legacy mobile-api-worker envelope was `{ success, data }` (lists added
 * `pagination: { page, pageSize, totalCount, totalPages, hasMore }`); app-api
 * returns `{ data }` / `{ data, pagination: { totalCount, hasMore, cursor } }`
 * and THROWS on non-2xx. These helpers adapt app-api responses back to the
 * legacy screen-facing shape so screens need zero changes.
 *
 * Written by the P1 `core-user` package; imported by every services/modules/*
 * file and by the facade assembler in services/api.ts.
 */

import type { ApiResponse } from '@weldsuite/mobile-ui/types';

// ============================================================================
// app-api envelope types (mirrors packages/clients/app-api-client/src/types.ts)
// ============================================================================

export interface AppApiPagination {
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

export interface AppApiListEnvelope<T> {
  data: T[];
  pagination?: AppApiPagination;
}

// ============================================================================
// Error adaptation — app-api client throws; legacy callers expect
// `{ success: false, error: { title, message } }`.
// ============================================================================

/** Duck-typed check for the ApiError thrown by @weldsuite/api-client. */
function isApiErrorLike(err: unknown): err is { status: number; message: string } {
  return (
    !!err &&
    typeof err === 'object' &&
    typeof (err as { status?: unknown }).status === 'number' &&
    typeof (err as { message?: unknown }).message === 'string'
  );
}

export function toError(err: unknown): ApiResponse<never> {
  if (isApiErrorLike(err)) {
    return { success: false, error: { title: `api_error_${err.status}`, message: err.message } };
  }
  return {
    success: false,
    error: { title: 'network_error', message: err instanceof Error ? err.message : 'Request failed' },
  };
}

/** Stub response for legacy methods with no app-api equivalent. */
export function notSupported(message: string): ApiResponse<never> {
  return { success: false, error: { title: 'not_supported', message } };
}

// ============================================================================
// Query building — legacy `filters[...]` bracket params flatten to plain
// query params on app-api; empty values are omitted.
// ============================================================================

export function buildQuery(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  }
  const query = searchParams.toString();
  return query ? `?${query}` : '';
}

// ============================================================================
// Cursor memory — app-api is cursor-paginated while the screens do
// page-increment infinite scroll. Each list endpoint stores the cursor from
// its last response under a stable key; a request for page > 1 replays it,
// and page 1 (or an omitted page) resets the stream.
// ============================================================================

const cursorStore = new Map<string, string>();

/** Cursor to send for the requested page (undefined = start of stream). */
export function cursorForPage(key: string, page?: number): string | undefined {
  if (!page || page <= 1) {
    cursorStore.delete(key);
    return undefined;
  }
  return cursorStore.get(key);
}

/** Remember the next-page cursor from an app-api list response. */
export function rememberCursor(key: string, pagination?: AppApiPagination | null): void {
  if (pagination?.cursor) {
    cursorStore.set(key, pagination.cursor);
  } else {
    cursorStore.delete(key);
  }
}

// ============================================================================
// List adaptation — screens are split between reading `response.data.data`
// / `response.data.items` and `response.data.pagination` / `response.data.meta`,
// so the legacy list shape emits ALL of them.
// ============================================================================

export interface LegacyListData<T> {
  data: T[];
  items: T[];
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
    hasMore: boolean;
  };
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/**
 * Adapt an app-api `{ data, pagination }` list envelope to the legacy
 * paginated shape. `page`/`limit` echo what the screen requested (app-api
 * itself is cursor-based).
 */
export function toLegacyList<T>(
  envelope: AppApiListEnvelope<T>,
  page: number = 1,
  limit: number = 25,
): ApiResponse<LegacyListData<T>> {
  const items = envelope.data ?? [];
  const totalCount = envelope.pagination?.totalCount ?? items.length;
  const hasMore = envelope.pagination?.hasMore ?? false;
  const totalPages = limit > 0 ? Math.ceil(totalCount / limit) : 1;
  return {
    success: true,
    data: {
      data: items,
      items,
      pagination: { page, pageSize: limit, totalCount, totalPages, hasMore },
      meta: { page, limit, total: totalCount, totalPages },
    },
  };
}
