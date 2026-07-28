import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

/**
 * WeldConnect connector queries — the Nango-backed `/api/nango/*` surface.
 *
 * The connect flow is deliberately three steps: the client asks app-api for a
 * Connect session, opens Nango's hosted UI with the returned token, and reports
 * the resulting connection id back. Nango's auth webhook normally activates the
 * connection first; the finalize call is the belt-and-braces path so the UI is
 * never blocked on webhook delivery.
 */

// =============================================================================
// Query Keys
// =============================================================================

const nangoKeys = {
  all: ['nango'] as const,
  catalog: () => [...nangoKeys.all, 'catalog'] as const,
  connections: () => [...nangoKeys.all, 'connections'] as const,
  connection: (id: string) => [...nangoKeys.all, 'connection', id] as const,
  runs: (id: string) => [...nangoKeys.all, 'runs', id] as const,
};

// =============================================================================
// Types
// =============================================================================

export type NangoConnectionStatus = 'pending' | 'active' | 'auth_error' | 'sync_error' | 'paused';
export type NangoSyncRunStatus = 'running' | 'success' | 'error' | 'partial';

export interface NangoConnection {
  id: string;
  providerConfigKey: string;
  provider: string;
  label: string;
  icon: string;
  category: string;
  displayName: string | null;
  status: NangoConnectionStatus;
  scopes: string[];
  externalAccountId: string | null;
  enabledSyncs: string[];
  lastSyncAt: string | null;
  lastSyncStatus: NangoSyncRunStatus | null;
  lastError: string | null;
  lastErrorAt: string | null;
  recordsSynced: number;
  connectedAt: string | null;
  connectedBy: string | null;
  isConnected: boolean;
}

export interface NangoSyncHealth {
  name: string;
  status: string;
  type?: string;
  finishedAt?: string | null;
  nextScheduledSyncAt?: string | null;
}

export interface NangoConnectionDetail extends NangoConnection {
  syncs: NangoSyncHealth[];
}

export interface NangoConnectorSync {
  syncName: string;
  model: string;
  internalEntity: 'company' | 'person' | 'opportunity';
}

export interface NangoConnector {
  providerConfigKey: string;
  provider: string;
  label: string;
  description: string;
  category: string;
  icon: string;
  scopes: string[];
  syncs: NangoConnectorSync[];
  connection: NangoConnection | null;
}

export interface NangoSyncRun {
  id: string;
  connectionId: string;
  syncName: string;
  model: string;
  status: NangoSyncRunStatus;
  trigger: string;
  syncType: string | null;
  recordsAdded: number;
  recordsUpdated: number;
  recordsDeleted: number;
  recordsCreated: number;
  recordsModified: number;
  recordsSkipped: number;
  recordsFailed: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

export interface NangoConnectSession {
  connectionId: string;
  providerConfigKey: string;
  sessionToken: string;
  expiresAt: string;
  connectUrl: string;
}

// =============================================================================
// Queries
// =============================================================================

export function useNangoCatalog() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: nangoKeys.catalog(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: NangoConnector[] }>('/nango/catalog');
    },
  });
}

export function useNangoConnections() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: nangoKeys.connections(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: NangoConnection[] }>('/nango/connections');
    },
  });
}

/**
 * Connection detail with live sync health.
 *
 * Polled while a connection is syncing so the health panel converges without
 * the user reloading; the interval stops once the connection settles.
 */
export function useNangoConnection(id: string | null, options?: { pollWhileRunning?: boolean }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: nangoKeys.connection(id ?? ''),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      if (!options?.pollWhileRunning) return false;
      const data = query.state.data as { data?: NangoConnectionDetail } | undefined;
      const running = data?.data?.syncs?.some((s) => s.status === 'RUNNING');
      return running || data?.data?.status === 'pending' ? 5000 : false;
    },
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: NangoConnectionDetail }>(`/nango/connections/${id}`);
    },
  });
}

export function useNangoSyncRuns(id: string | null, limit = 25) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: nangoKeys.runs(id ?? ''),
    enabled: Boolean(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: NangoSyncRun[] }>(`/nango/connections/${id}/runs?limit=${limit}`);
    },
  });
}

// =============================================================================
// Mutations
// =============================================================================

/** Step 1 — mint a Connect session for a connector. */
export function useCreateNangoConnectSession() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (providerConfigKey: string) => {
      const client = await getClient();
      const result = await client.post<{ data: NangoConnectSession }>('/nango/connect-session', {
        providerConfigKey,
      });
      return result.data;
    },
  });
}

/** Step 2 — report the connection id the Connect UI produced. */
export function useFinalizeNangoConnection() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      connectionId,
      nangoConnectionId,
    }: {
      connectionId: string;
      nangoConnectionId: string;
    }) => {
      const client = await getClient();
      return client.post<{ data: NangoConnection }>(`/nango/connections/${connectionId}/finalize`, {
        nangoConnectionId,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: nangoKeys.all });
    },
  });
}

export function useTriggerNangoSync() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ connectionId, full }: { connectionId: string; full?: boolean }) => {
      const client = await getClient();
      return client.post<{ data: { triggered: string[]; full: boolean } }>(
        `/nango/connections/${connectionId}/sync`,
        { full: full ?? false },
      );
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: nangoKeys.connection(variables.connectionId) });
      qc.invalidateQueries({ queryKey: nangoKeys.runs(variables.connectionId) });
    },
  });
}

export function useSetNangoConnectionPaused() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ connectionId, paused }: { connectionId: string; paused: boolean }) => {
      const client = await getClient();
      return client.post<{ data: { status: string } }>(
        `/nango/connections/${connectionId}/${paused ? 'pause' : 'resume'}`,
        {},
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: nangoKeys.all });
    },
  });
}

export function useDisconnectNangoConnection() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      const client = await getClient();
      return client.delete<{ data: { id: string; disconnected: boolean } }>(
        `/nango/connections/${connectionId}`,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: nangoKeys.all });
    },
  });
}
