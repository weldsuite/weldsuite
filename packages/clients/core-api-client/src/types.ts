/**
 * Shared response types matching the core-api format.
 */

// ============================================================================
// Response Wrappers
// ============================================================================

export interface DataResponse<T> {
  data: T;
}

export interface ListResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface PaginationMeta {
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

// ============================================================================
// Client API Interface
// ============================================================================

export interface ClientApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, data?: unknown): Promise<T>;
  put<T>(path: string, data?: unknown): Promise<T>;
  patch<T>(path: string, data?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

// ============================================================================
// Query Helpers
// ============================================================================

export function buildQueryString(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  }
  const query = searchParams.toString();
  return query ? `?${query}` : '';
}
