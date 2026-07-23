import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

export interface AuditLogRecord {
  id: string;
  createdAt: string;
  entityType: string;
  entityId: string;
  action: string;
  description: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
  /** Full entity snapshot at the time of the event (`audit_logs.data`). */
  data?: Record<string, unknown>;
  performedBy?: string;
  performedByName?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogFilters {
  entityType?: string;
  entityId?: string;
  action?: string;
  performedBy?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

const auditLogKeys = {
  all: ['audit-logs'] as const,
  lists: () => [...auditLogKeys.all, 'list'] as const,
  list: (filters?: AuditLogFilters) => [...auditLogKeys.lists(), filters] as const,
  entity: (entityType: string, entityId: string) =>
    [...auditLogKeys.all, 'entity', entityType, entityId] as const,
};

/**
 * Numbered-page list of audit logs, newest first.
 *
 * Passing `page` puts app-api's `/audit-logs` into offset mode, which returns
 * `page`/`pageSize`/`totalPages` alongside the usual cursor meta — that is what
 * the Prev/Next pager in `app/settings/activity/page.tsx` reads.
 */
export function useAuditLogs(filters?: AuditLogFilters) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: auditLogKeys.list(filters),
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams();
      if (filters) {
        Object.entries(filters).forEach(([key, value]) => {
          if (value !== undefined && value !== null && value !== '') {
            params.set(key, String(value));
          }
        });
      }
      // `page` is what selects offset mode server-side; default it so the pager
      // never silently degrades to a cursor response with no `totalPages`.
      if (!params.has('page')) params.set('page', '1');
      const query = params.toString();
      return client.get<{
        data: AuditLogRecord[];
        pagination: {
          page: number;
          pageSize: number;
          totalCount: number;
          totalPages: number;
          hasMore: boolean;
          cursor: string | null;
        };
      }>(`/audit-logs${query ? `?${query}` : ''}`);
    },
    placeholderData: keepPreviousData,
  });
}

export function useEntityAuditLogs(entityType: string, entityId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: auditLogKeys.entity(entityType, entityId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: AuditLogRecord[] }>(`/audit-logs/${entityType}/${entityId}`);
    },
    enabled: !!entityType && !!entityId,
  });
}
