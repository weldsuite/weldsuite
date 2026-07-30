import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

/**
 * WeldConnect connector queries — the `/api/connectors/*` surface.
 *
 * Two connect flows, because connectors support different auth:
 *
 *   - **OAuth** is a full-page redirect. `useStartConnectorOAuth` returns the
 *     provider's authorize URL and the browser leaves; the provider redirects to
 *     app-api's public callback, which completes the exchange server-side and
 *     sends the user back here with `?connectorConnected=` or `?connectorError=`.
 *     No popup and no client-side finalise step — the code never touches the
 *     browser, so there is nothing for the client to report back.
 *   - **API token** is a single mutation. The token is validated against the
 *     provider before the connection activates, so a bad paste fails immediately.
 */

// =============================================================================
// Query Keys
// =============================================================================

const connectorKeys = {
  all: ['connectors'] as const,
  catalog: () => [...connectorKeys.all, 'catalog'] as const,
  connections: () => [...connectorKeys.all, 'connections'] as const,
  connection: (id: string) => [...connectorKeys.all, 'connection', id] as const,
  runs: (id: string) => [...connectorKeys.all, 'runs', id] as const,
};

// =============================================================================
// Types
// =============================================================================

export type ConnectorConnectionStatus =
  | 'pending'
  | 'active'
  | 'auth_error'
  | 'sync_error'
  | 'paused';
export type ConnectorSyncRunStatus = 'running' | 'success' | 'error' | 'partial';
export type ConnectorAuthMode = 'oauth2' | 'api_token';

export interface ConnectorConnection {
  id: string;
  connectorId: string;
  authMode: ConnectorAuthMode;
  displayName: string | null;
  status: ConnectorConnectionStatus;
  scopes: string[] | null;
  externalAccountId: string | null;
  enabledEntities: string[] | null;
  syncWatermarks: Record<string, string> | null;
  syncIntervalHours: number | null;
  lastSyncAt: string | null;
  lastSyncStatus: ConnectorSyncRunStatus | null;
  lastError: string | null;
  lastErrorAt: string | null;
  recordsSynced: number;
  connectedAt: string | null;
  connectedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogConnector {
  id: string;
  label: string;
  description: string;
  category: string;
  icon: string;
  scopes: string[];
  /** What the driver actually supports — drives which connect form is offered. */
  authModes: ConnectorAuthMode[];
  entities: string[];
  supportsWebhooks: boolean;
  connection: ConnectorConnection | null;
}

export interface ConnectorSyncRun {
  id: string;
  connectionId: string;
  entityType: string;
  status: ConnectorSyncRunStatus;
  trigger: string;
  recordsCreated: number;
  recordsModified: number;
  recordsSkipped: number;
  recordsDeleted: number;
  recordsFailed: number;
  pagesRead: number;
  /** True when the run stopped at the page ceiling with more data waiting. */
  truncated: boolean;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  errorSamples: Array<{ externalId: string; message: string }> | null;
  createdAt: string;
}

export interface SyncRunSummary {
  runId: string;
  status: ConnectorSyncRunStatus;
  created: number;
  modified: number;
  skipped: number;
  deleted: number;
  failed: number;
  pagesRead: number;
  truncated: boolean;
  error?: string;
}

// =============================================================================
// Queries
// =============================================================================

export function useConnectorCatalog() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: connectorKeys.catalog(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: CatalogConnector[] }>('/connectors/catalog');
    },
  });
}

export function useConnectorConnections() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: connectorKeys.connections(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ConnectorConnection[] }>('/connectors/connections');
    },
  });
}

/**
 * Connection detail.
 *
 * Polled while a connection is still `pending` so the panel converges after an
 * OAuth redirect without the user reloading. It settles as soon as the status
 * moves, so there is no permanent interval.
 */
export function useConnectorConnection(
  id: string | null,
  options?: { pollWhilePending?: boolean },
) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: connectorKeys.connection(id ?? ''),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      if (!options?.pollWhilePending) return false;
      const data = query.state.data as { data?: ConnectorConnection } | undefined;
      return data?.data?.status === 'pending' ? 5000 : false;
    },
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ConnectorConnection }>(`/connectors/connections/${id}`);
    },
  });
}

export function useConnectorSyncRuns(id: string | null) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: connectorKeys.runs(id ?? ''),
    enabled: Boolean(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ConnectorSyncRun[] }>(`/connectors/connections/${id}/runs`);
    },
  });
}

// =============================================================================
// Mutations
// =============================================================================

/**
 * Begin an OAuth connect.
 *
 * Returns the provider's authorize URL; the caller navigates the whole page
 * there. `redirectUri` must be app-api's public callback and must byte-match what
 * the token exchange later sends, or the provider rejects it.
 */
export function useStartConnectorOAuth() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({
      connectorId,
      redirectUri,
    }: {
      connectorId: string;
      redirectUri: string;
    }) => {
      const client = await getClient();
      const result = await client.post<{ data: { connectionId: string; authorizeUrl: string } }>(
        '/connectors/oauth/start',
        { connectorId, redirectUri },
      );
      return result.data;
    },
  });
}

/** Connect with a tenant-supplied API token. */
export function useConnectWithApiToken() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      connectorId,
      apiToken,
      settings,
    }: {
      connectorId: string;
      apiToken: string;
      settings?: Record<string, unknown>;
    }) => {
      const client = await getClient();
      return client.post<{ data: ConnectorConnection }>('/connectors/api-token', {
        connectorId,
        apiToken,
        ...(settings ? { settings } : {}),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: connectorKeys.all });
    },
  });
}

/**
 * Run a sync now.
 *
 * Resolves only when the sync has finished, because the route runs it inline
 * rather than enqueuing — so the returned summaries are the real counts, not an
 * acknowledgement.
 */
export function useTriggerConnectorSync() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      connectionId,
      entityType,
      fullResync,
    }: {
      connectionId: string;
      entityType?: string;
      fullResync?: boolean;
    }) => {
      const client = await getClient();
      return client.post<{ data: SyncRunSummary[] }>(
        `/connectors/connections/${connectionId}/sync`,
        { ...(entityType ? { entityType } : {}), fullResync: fullResync ?? false },
      );
    },
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: connectorKeys.connection(variables.connectionId) });
      qc.invalidateQueries({ queryKey: connectorKeys.runs(variables.connectionId) });
      qc.invalidateQueries({ queryKey: connectorKeys.catalog() });
    },
  });
}

export function useSetConnectorPaused() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ connectionId, paused }: { connectionId: string; paused: boolean }) => {
      const client = await getClient();
      return client.post<{ data: { id: string; status: string } }>(
        `/connectors/connections/${connectionId}/${paused ? 'pause' : 'resume'}`,
        {},
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: connectorKeys.all });
    },
  });
}

export function useDisconnectConnector() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      const client = await getClient();
      return client.delete<void>(`/connectors/connections/${connectionId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: connectorKeys.all });
    },
  });
}
