import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

/**
 * WeldConnect connector queries — first-party sync (`/connectors/*`).
 */

const connectorKeys = {
  all: ['connectors'] as const,
  catalog: () => [...connectorKeys.all, 'catalog'] as const,
  connections: () => [...connectorKeys.all, 'connections'] as const,
  connection: (id: string) => [...connectorKeys.all, 'connection', id] as const,
  runs: (id: string) => [...connectorKeys.all, 'runs', id] as const,
};

export type ConnectorConnectionStatus = 'pending' | 'active' | 'auth_error' | 'sync_error' | 'paused';
export type ConnectorSyncRunStatus = 'running' | 'success' | 'error' | 'partial';

export interface ConnectorAuthField {
  key: string;
  label: string;
  type: 'url' | 'text' | 'secret';
  placeholder?: string;
  required?: boolean;
}

export interface ConnectorSyncDef {
  syncName: string;
  model: string;
  internalEntity: 'product' | 'order' | 'person' | 'party' | 'invoice' | 'bill';
  settingKey: 'products' | 'orders' | 'customers' | 'contacts' | 'invoices' | 'bills';
}

export interface ConnectorConnection {
  id: string;
  provider: string;
  label: string;
  icon: string;
  category: string;
  displayName: string | null;
  status: ConnectorConnectionStatus;
  externalAccountId: string | null;
  enabledSyncs: string[];
  authFields: ConnectorAuthField[];
  syncs: ConnectorSyncDef[];
  lastSyncAt: string | null;
  lastSyncStatus: ConnectorSyncRunStatus | null;
  lastError: string | null;
  lastErrorAt: string | null;
  recordsSynced: number;
  connectedAt: string | null;
  connectedBy: string | null;
  isConnected: boolean;
  webhookCount?: number;
  warning?: string | null;
}

export interface ConnectorCatalogEntry {
  provider: string;
  label: string;
  description: string;
  category: string;
  icon: string;
  auth: { kind: 'api_key' | 'app_auth' | 'oauth2'; fields: ConnectorAuthField[]; scopes?: string[] };
  syncs: ConnectorSyncDef[];
  connections: ConnectorConnection[];
  connectionCount: number;
}

export interface ConnectorSyncRun {
  id: string;
  connectionId: string;
  syncName: string;
  model: string;
  status: ConnectorSyncRunStatus;
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

export interface ConnectConnectorInput {
  provider: string;
  displayName?: string;
  credentials: Record<string, string>;
  enabledSyncs: string[];
}

export interface UpdateConnectorInput {
  displayName?: string;
  enabledSyncs?: string[];
  credentials?: Record<string, string>;
}

export function useConnectorCatalog() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: connectorKeys.catalog(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ConnectorCatalogEntry[] }>('/connectors/catalog');
    },
  });
}

export function useConnectorConnection(id: string | null, options?: { pollWhileRunning?: boolean }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: connectorKeys.connection(id ?? ''),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      if (!options?.pollWhileRunning) return false;
      const data = query.state.data as { data?: ConnectorConnection } | undefined;
      return data?.data?.lastSyncStatus === 'running' ? 4000 : false;
    },
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ConnectorConnection }>(`/connectors/connections/${id}`);
    },
  });
}

export function useConnectorSyncRuns(id: string | null, limit = 25) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: connectorKeys.runs(id ?? ''),
    enabled: Boolean(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ConnectorSyncRun[] }>(`/connectors/connections/${id}/runs?limit=${limit}`);
    },
  });
}

function invalidateConnectorQueries(queryClient: ReturnType<typeof useQueryClient>, connectionId?: string) {
  void queryClient.invalidateQueries({ queryKey: connectorKeys.catalog() });
  void queryClient.invalidateQueries({ queryKey: connectorKeys.connections() });
  if (connectionId) {
    void queryClient.invalidateQueries({ queryKey: connectorKeys.connection(connectionId) });
    void queryClient.invalidateQueries({ queryKey: connectorKeys.runs(connectionId) });
  }
}

export interface AuthorizeConnectorInput {
  provider: 'woocommerce' | 'moneybird';
  storeUrl?: string;
  displayName?: string;
  enabledSyncs: string[];
  returnUrl: string;
}

export interface MoneybirdAdministration {
  id: string;
  name: string;
  language?: string | null;
  currency?: string | null;
}

export interface ConnectorOAuthCallbackResult {
  connection: ConnectorConnection;
  administrations: MoneybirdAdministration[];
  needsPicker: boolean;
  returnUrl: string;
}

export function useAuthorizeConnector() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AuthorizeConnectorInput) => {
      const client = await getClient();
      return client.post<{ data: { authorizeUrl: string; connectionId?: string } }>('/connectors/authorize', input);
    },
    onSuccess: () => invalidateConnectorQueries(queryClient),
  });
}

export function useConnectorOAuthCallback() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { provider: 'moneybird'; code: string; state: string }) => {
      const client = await getClient();
      return client.post<{ data: ConnectorOAuthCallbackResult }>('/connectors/oauth/callback', input);
    },
    onSuccess: () => invalidateConnectorQueries(queryClient),
  });
}

export function useSelectConnectorAccount() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { connectionId: string; administrationId: string }) => {
      const client = await getClient();
      return client.post<{ data: { connection: ConnectorConnection } }>(
        `/connectors/connections/${input.connectionId}/select-account`,
        { administrationId: input.administrationId },
      );
    },
    onSuccess: (_data, vars) => invalidateConnectorQueries(queryClient, vars.connectionId),
  });
}

export function useTestConnector() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (input: { provider: string; credentials: Record<string, string> }) => {
      const client = await getClient();
      return client.post<{ data: { ok: boolean; storeUrl: string } }>('/connectors/test', input);
    },
  });
}

export function useConnectConnector() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConnectConnectorInput) => {
      const client = await getClient();
      return client.post<{ data: ConnectorConnection }>('/connectors/connect', input);
    },
    onSuccess: () => invalidateConnectorQueries(queryClient),
  });
}

export function useUpdateConnector() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ connectionId, ...input }: UpdateConnectorInput & { connectionId: string }) => {
      const client = await getClient();
      return client.patch<{ data: ConnectorConnection }>(`/connectors/connections/${connectionId}`, input);
    },
    onSuccess: (_data, vars) => invalidateConnectorQueries(queryClient, vars.connectionId),
  });
}

export function useTriggerConnectorSync() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { connectionId: string; full?: boolean; syncs?: string[] }) => {
      const client = await getClient();
      return client.post<{ data: { triggered: string[]; full: boolean } }>(
        `/connectors/connections/${input.connectionId}/sync`,
        { full: input.full, syncs: input.syncs },
      );
    },
    onSuccess: (_data, vars) => invalidateConnectorQueries(queryClient, vars.connectionId),
  });
}

export function useSetConnectorPaused() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { connectionId: string; paused: boolean }) => {
      const client = await getClient();
      const path = input.paused
        ? `/connectors/connections/${input.connectionId}/pause`
        : `/connectors/connections/${input.connectionId}/resume`;
      return client.post<{ data: { status: string } }>(path, {});
    },
    onSuccess: (_data, vars) => invalidateConnectorQueries(queryClient, vars.connectionId),
  });
}

export function useDisconnectConnector() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      const client = await getClient();
      return client.delete<{ data: { id: string; disconnected: boolean } }>(
        `/connectors/connections/${connectionId}`,
      );
    },
    onSuccess: () => invalidateConnectorQueries(queryClient),
  });
}
