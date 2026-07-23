/**
 * Resolve a chat entity-mention chip's display title at render time.
 *
 * Each chip stores `(type, id, fallbackLabel)` inline in the message body.
 * On render, we want the LIVE title (so renames are reflected) but with a
 * graceful fallback when the user lacks permission, the entity was deleted,
 * or the request is still loading.
 *
 * Implementation notes:
 * - We do a raw `fetch` (not the ClientApi wrapper) so we can distinguish 403
 *   vs 404 vs other HTTP errors, which the wrapper coerces into a single
 *   `Error` with no structured status.
 * - Auth token is sourced via `useAuth().getToken()` from Clerk.
 * - React-query dedupes by `[entity-title, type, id]`, so 50 chips that
 *   reference the same customer cause one network request.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import type { EntitySheetType } from '@/components/entity-sheet/types';

const APP_API_URL =
  (import.meta as { env?: { VITE_APP_API_URL?: string } }).env?.VITE_APP_API_URL ||
  'http://localhost:8789';

const API_PREFIX = '/api';

type EntityFetchPath = (id: string) => string;

/**
 * Map each entity type to its app-api GET-by-id endpoint and the JSON field to
 * read for the display title. The `data` envelope (`{ data: {...} }`) is
 * unwrapped automatically below.
 *
 * Two renames to note on the way over from api-worker: CRM customers are served
 * by `/companies` on app-api (the customer surface is a status-flag projection
 * over companies, not its own object) and CRM contacts by `/people`. The old
 * `/crm/customers` + `/crm/contacts` routes were deleted from api-worker in
 * 42ff1442a, so those two chips have been resolving to 404 — and rendering
 * their fallback label — ever since.
 */
const ENTITY_CONFIG: Record<
  EntitySheetType,
  { path: EntityFetchPath; titleFields: readonly string[] }
> = {
  customer: { path: (id) => `/companies/${id}`, titleFields: ['displayName', 'name', 'companyName'] },
  contact: { path: (id) => `/people/${id}`, titleFields: ['displayName', 'name', 'fullName', 'email'] },
  lead: { path: (id) => `/leads/${id}`, titleFields: ['name', 'companyName', 'email'] },
  opportunity: { path: (id) => `/opportunities/${id}`, titleFields: ['name', 'title'] },
  ticket: { path: (id) => `/tickets/${id}`, titleFields: ['subject', 'title'] },
  article: { path: (id) => `/articles/${id}`, titleFields: ['title'] },
  product: { path: (id) => `/products/${id}`, titleFields: ['name', 'title'] },
  order: { path: (id) => `/orders/${id}`, titleFields: ['orderNumber', 'name'] },
  invoice: { path: (id) => `/invoices/${id}`, titleFields: ['invoiceNumber', 'number', 'name'] },
  bill: { path: (id) => `/bills/${id}`, titleFields: ['billNumber', 'number', 'name'] },
  project: { path: (id) => `/projects/${id}`, titleFields: ['name', 'title', 'code'] },
  task: { path: (id) => `/tasks/${id}`, titleFields: ['title', 'name'] },
  domain: { path: (id) => `/domains/${id}`, titleFields: ['fullDomain', 'name'] },
};

export type EntityTitleStatus = 'loading' | 'ok' | 'forbidden' | 'notfound' | 'error';

export interface EntityTitleResult {
  status: EntityTitleStatus;
  title: string | null;
}

/**
 * Sentinel return type from the queryFn — distinguishes "I deliberately
 * resolved to a non-ok status" from "react-query is loading or errored".
 */
type EntityTitlePayload =
  | { status: 'ok'; title: string }
  | { status: 'forbidden' }
  | { status: 'notfound' };

function pickTitle(record: unknown, fields: readonly string[]): string | null {
  if (!record || typeof record !== 'object') return null;
  const obj = record as Record<string, unknown>;
  for (const field of fields) {
    const v = obj[field];
    if (typeof v === 'string' && v.trim().length > 0) {
      return v.trim();
    }
  }
  return null;
}

export function useEntityTitle(
  type: EntitySheetType,
  id: string,
): { status: EntityTitleStatus; title: string | null } {
  const { getToken } = useAuth();

  const query: UseQueryResult<EntityTitlePayload> = useQuery<EntityTitlePayload>({
    queryKey: ['weldchat', 'entity-title', type, id],
    enabled: !!id && !!type,
    staleTime: 5 * 60 * 1000, // 5 min
    gcTime: 30 * 60 * 1000, // 30 min
    retry: false, // 403/404 should not retry
    queryFn: async (): Promise<EntityTitlePayload> => {
      const config = ENTITY_CONFIG[type];
      if (!config) return { status: 'notfound' } as const;

      const token = await getToken();
      const response = await fetch(`${APP_API_URL}${API_PREFIX}${config.path(id)}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      if (response.status === 403 || response.status === 401) {
        return { status: 'forbidden' } as const;
      }
      if (response.status === 404) {
        return { status: 'notfound' } as const;
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch ${type} ${id}: HTTP ${response.status}`);
      }

      const json = (await response.json()) as { data?: unknown };
      const record = (json && typeof json === 'object' && 'data' in json ? json.data : json) ?? null;
      const title = pickTitle(record, config.titleFields);
      // Server returned 200 — emit ok with the live title (or empty when the
      // record lacks every candidate field; the chip falls back to its
      // baked-in label in that case).
      return { status: 'ok', title: title ?? '' } as const;
    },
  });

  if (query.isLoading || query.isPending) {
    return { status: 'loading', title: null };
  }
  if (query.isError) {
    return { status: 'error', title: null };
  }
  const data = query.data;
  if (!data) return { status: 'loading', title: null };
  if (data.status === 'forbidden') return { status: 'forbidden', title: null };
  if (data.status === 'notfound') return { status: 'notfound', title: null };
  return { status: 'ok', title: data.title || null };
}
