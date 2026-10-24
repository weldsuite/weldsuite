import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

type SyncDirection = 'inbound' | 'outbound' | 'bidirectional';

/**
 * WeldConnect connector queries — first-party sync (`/connectors/*`).
 */

const connectorKeys = {
  all: ['connectors'] as const,
  catalog: () => [...connectorKeys.all, 'catalog'] as const,
  connections: () => [...connectorKeys.all, 'connections'] as const,
  connection: (id: string) => [...connectorKeys.all, 'connection', id] as const,
  runs: (id: string) => [...connectorKeys.all, 'runs', id] as const,
  records: (id: string) => [...connectorKeys.all, 'records', id] as const,
  fieldMappings: (id: string, entityType?: string) =>
    [...connectorKeys.all, 'field-mappings', id, entityType ?? 'all'] as const,
  moneybirdPushOptions: (id: string) => [...connectorKeys.all, 'moneybird-push-options', id] as const,
  moneybirdPushStatus: (id: string) => [...connectorKeys.all, 'moneybird-push-status', id] as const,
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
  internalEntity: string;
  settingKey: string;
}

export interface MoneybirdPushTaxRateOverrides {
  reverseCharge: string | null;
  outsideEu: string | null;
  exempt: string | null;
  noTax: string | null;
}

export interface MoneybirdPushSettings {
  enabled: boolean;
  sourceConnectionIds: string[];
  revenueLedgerAccountId: string | null;
  financialAccountId: string | null;
  feeLedgerAccountId: string | null;
  payoutLedgerAccountId: string | null;
  taxRateOverrides: MoneybirdPushTaxRateOverrides;
  startDate: string | null;
}

export interface ConnectorConnectionSettings {
  importStartDate?: string | null;
  moneybirdPush?: MoneybirdPushSettings | null;
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
  entityId: string | null;
  enabledSyncs: string[];
  direction: SyncDirection;
  objectSyncDirections: Record<string, SyncDirection>;
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
  settings: ConnectorConnectionSettings;
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
  errorSamples?: Array<{ externalId: string; message: string }> | null;
  createdAt: string;
}

export interface ConnectorSyncedRecord {
  id: string;
  externalEntityType: string;
  externalEntityId: string;
  internalEntityType: string;
  internalEntityId: string;
  label: string;
  lastSyncedAt: string | null;
}

export interface ConnectConnectorInput {
  provider: string;
  displayName?: string;
  credentials: Record<string, string>;
  enabledSyncs: string[];
  entityId?: string;
  settings?: Partial<ConnectorConnectionSettings>;
}

export interface UpdateConnectorInput {
  displayName?: string;
  enabledSyncs?: string[];
  direction?: SyncDirection;
  objectSyncDirections?: Record<string, SyncDirection> | null;
  credentials?: Record<string, string>;
  entityId?: string | null;
  settings?: Partial<ConnectorConnectionSettings>;
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

export function useConnectorSyncRuns(id: string | null, options?: { pollWhileRunning?: boolean }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: connectorKeys.runs(id ?? ''),
    enabled: Boolean(id),
    refetchInterval: options?.pollWhileRunning ? 4000 : false,
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ConnectorSyncRun[] }>(`/connectors/connections/${id}/runs?limit=25`);
    },
  });
}

export function useConnectorRecords(id: string | null, options?: { pollWhileRunning?: boolean }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: connectorKeys.records(id ?? ''),
    enabled: Boolean(id),
    refetchInterval: options?.pollWhileRunning ? 4000 : false,
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ConnectorSyncedRecord[] }>(`/connectors/connections/${id}/records?limit=50`);
    },
  });
}

function invalidateConnectorQueries(queryClient: ReturnType<typeof useQueryClient>, connectionId?: string) {
  void queryClient.invalidateQueries({ queryKey: connectorKeys.catalog() });
  void queryClient.invalidateQueries({ queryKey: connectorKeys.connections() });
  if (connectionId) {
    void queryClient.invalidateQueries({ queryKey: connectorKeys.connection(connectionId) });
    void queryClient.invalidateQueries({ queryKey: connectorKeys.runs(connectionId) });
    void queryClient.invalidateQueries({ queryKey: connectorKeys.records(connectionId) });
  }
}

export interface AuthorizeConnectorInput {
  provider: 'woocommerce' | 'moneybird' | 'stripe';
  storeUrl?: string;
  displayName?: string;
  enabledSyncs: string[];
  returnUrl: string;
  entityId?: string;
  importStartDate?: string;
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
    mutationFn: async (input: { provider: 'stripe' | 'moneybird'; code: string; state: string }) => {
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

export interface ConnectorFieldMapping {
  id: string;
  connectionId: string;
  entityType: string;
  externalFieldPath: string;
  internalFieldPath: string;
  direction: SyncDirection;
  transformType: 'direct' | 'lookup' | 'format_date' | 'custom';
  transformConfig: Record<string, unknown> | null;
  isRequired: boolean;
  isDefault: boolean;
  position: number;
}

export interface ConnectorFieldMappingDefinition {
  externalFieldPath: string;
  internalFieldPath: string;
  direction: SyncDirection;
  transformType: 'direct' | 'lookup' | 'format_date' | 'custom';
  transformConfig?: Record<string, unknown>;
  isRequired?: boolean;
}

export function useConnectorFieldMappings(connectionId: string | null, entityType?: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: connectorKeys.fieldMappings(connectionId ?? '', entityType),
    enabled: Boolean(connectionId),
    queryFn: async () => {
      const client = await getClient();
      const params = entityType ? `?entityType=${encodeURIComponent(entityType)}` : '';
      return client.get<{ data: ConnectorFieldMapping[] }>(
        `/connectors/connections/${connectionId}/field-mappings${params}`,
      );
    },
  });
}

export function useConnectorDefaultFieldMappings(connectionId: string | null, entityType: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...connectorKeys.fieldMappings(connectionId ?? '', entityType), 'defaults'],
    enabled: Boolean(connectionId && entityType),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ConnectorFieldMappingDefinition[] }>(
        `/connectors/connections/${connectionId}/field-mappings/defaults?entityType=${encodeURIComponent(entityType)}`,
      );
    },
  });
}

export interface MoneybirdLedgerAccountOption {
  id: string;
  name: string;
  accountType: string;
}

export interface MoneybirdFinancialAccountOption {
  id: string;
  name: string;
  type: string;
  identifier: string;
}

export interface MoneybirdTaxRateOption {
  id: string;
  name: string;
  percentage: number;
  taxRateType: string;
}

export interface MoneybirdPushSourceConnection {
  id: string;
  displayName: string | null;
  externalAccountId: string | null;
}

export interface MoneybirdPushOptions {
  ledgerAccounts: MoneybirdLedgerAccountOption[];
  financialAccounts: MoneybirdFinancialAccountOption[];
  taxRates: MoneybirdTaxRateOption[];
  stripeConnections: MoneybirdPushSourceConnection[];
}

export function useMoneybirdPushOptions(connectionId: string | null, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: connectorKeys.moneybirdPushOptions(connectionId ?? ''),
    enabled: Boolean(connectionId) && enabled,
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: MoneybirdPushOptions }>(
        `/connectors/connections/${connectionId}/moneybird/options`,
      );
    },
  });
}

export interface MoneybirdPushErrorSample {
  externalId: string;
  message: string;
}

export interface MoneybirdPushLastRun {
  status: ConnectorSyncRunStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  errorSamples?: MoneybirdPushErrorSample[] | null;
}

export interface MoneybirdPushStatus {
  enabled: boolean;
  pushedInvoices: number;
  pendingInvoices: number;
  failedInvoices: number;
  pushedPayouts: number;
  pendingPayouts: number;
  lastRun: MoneybirdPushLastRun | null;
}

export function useMoneybirdPushStatus(connectionId: string | null, options?: { poll?: boolean }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: connectorKeys.moneybirdPushStatus(connectionId ?? ''),
    enabled: Boolean(connectionId),
    refetchInterval: (query) => {
      if (!options?.poll) return false;
      const data = query.state.data as { data?: MoneybirdPushStatus } | undefined;
      return data?.data?.lastRun?.status === 'running' ? 5000 : false;
    },
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: MoneybirdPushStatus }>(
        `/connectors/connections/${connectionId}/moneybird/push-status`,
      );
    },
  });
}

export function useTriggerMoneybirdPush() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      const client = await getClient();
      return client.post<{ data: { started: boolean } }>(
        `/connectors/connections/${connectionId}/moneybird/push`,
        {},
      );
    },
    onSuccess: (_data, connectionId) => {
      void queryClient.invalidateQueries({ queryKey: connectorKeys.moneybirdPushStatus(connectionId) });
      void queryClient.invalidateQueries({ queryKey: connectorKeys.connection(connectionId) });
    },
  });
}

export function useUpdateConnectorFieldMappings() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      connectionId: string;
      entityType: string;
      mappings: ConnectorFieldMappingDefinition[];
    }) => {
      const client = await getClient();
      return client.put<{ data: { entityType: string; count: number } }>(
        `/connectors/connections/${input.connectionId}/field-mappings`,
        { entityType: input.entityType, mappings: input.mappings },
      );
    },
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({
        queryKey: connectorKeys.fieldMappings(vars.connectionId, vars.entityType),
      });
    },
  });
}
