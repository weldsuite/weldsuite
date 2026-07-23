/**
 * Shared response envelope types for the app-api client.
 *
 * Kept aligned 1-to-1 with `apps/workers/app-api/src/lib/response.ts`. Changes to
 * the wire format must be made in both places.
 */

export interface PaginationMeta {
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

export interface DataResponse<T> {
  data: T;
}

export interface ListResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// Re-export the HTTP client interface from @weldsuite/api-client so consumers
// only need one import. Re-exporting (not redeclaring) is intentional —
// `createClientApi` returns a concrete `ClientApi`; a structurally-identical
// local redeclaration would be TS-distinct and force casts at every seam.
export type { ClientApi } from '@weldsuite/api-client/types';

/**
 * Build a query string from an object, omitting empty values. Mirrors the
 * `buildQueryString` in `@weldsuite/core-api-client/types`.
 */
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
