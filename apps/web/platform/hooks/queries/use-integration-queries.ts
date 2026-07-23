/**
 * Integration connections (Attio, HubSpot, Google Calendar, MCP servers).
 *
 * Backed by app-api — /api/integrations/connections + /api/integrations/entity-mappings.
 * Envelope is `{ data: T }`; DELETE returns 204 No Content.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

// =============================================================================
// Query Keys
// =============================================================================

export const integrationKeys = {
  all: ['integrations'] as const,
  connections: () => [...integrationKeys.all, 'connections'] as const,
  connection: (id: string) => [...integrationKeys.all, 'connection', id] as const,
  logs: (connectionId: string) => [...integrationKeys.all, 'logs', connectionId] as const,
  fieldMappings: (connectionId: string, entityType?: string) =>
    [...integrationKeys.all, 'field-mappings', connectionId, entityType] as const,
  defaultFieldMappings: (connectionId: string, entityType: string) =>
    [...integrationKeys.all, 'default-field-mappings', connectionId, entityType] as const,
  conflicts: (connectionId: string, filters?: { resolution?: string; entityType?: string }) =>
    [...integrationKeys.all, 'conflicts', connectionId, filters] as const,
  entitySyncStatus: (entityType: string, entityId: string) =>
    [...integrationKeys.all, 'entity-sync-status', entityType, entityId] as const,
};

// =============================================================================
// Types
// =============================================================================

export interface IntegrationConnection {
  id: string;
  provider: string;
  name: string | null;
  status: string;
  direction: string;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  companiesSynced: number;
  peopleSynced: number;
  connectedAt: string | null;
  connectedBy: string | null;
  syncSettings: {
    syncCompanies?: boolean;
    syncPeople?: boolean;
    syncIntervalHours?: number;
  } | null;
  triggerScheduleId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncLog {
  id: string;
  platform: string;
  connectionId: string;
  syncType: string;
  status: string;
  triggeredBy: string;
  itemsProcessed: number;
  totalItems: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsFailed: number;
  itemsSkipped: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: string;
}

// =============================================================================
// Queries
// =============================================================================

export function useIntegrationConnections() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: integrationKeys.connections(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: IntegrationConnection[] }>('/integrations/connections');
    },
  });
}

export function useIntegrationConnection(id: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: integrationKeys.connection(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{
        data: IntegrationConnection & { recentLogs: SyncLog[] };
      }>(`/integrations/connections/${id}`);
    },
    enabled: !!id,
  });
}

export function useIntegrationSyncLogs(connectionId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: integrationKeys.logs(connectionId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: SyncLog[] }>(`/integrations/connections/${connectionId}/logs`);
    },
    enabled: !!connectionId,
  });
}

// =============================================================================
// Mutations
// =============================================================================

export function useConnectAttio() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (redirectUri: string) => {
      const client = await getClient();
      return client.post<{ data: { authorizeUrl: string; state: string } }>(
        '/integrations/connections/attio/authorize',
        { redirectUri }
      );
    },
  });
}

export function useAttioCallback() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { code: string; state: string; redirectUri: string }) => {
      const client = await getClient();
      return client.post<{ data: { id: string; provider: string; status: string } }>(
        '/integrations/connections/attio/callback',
        params
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: integrationKeys.connections() });
    },
  });
}

export function useTriggerSync() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      const client = await getClient();
      return client.post<{ data: { message: string } }>(
        `/integrations/connections/${connectionId}/sync`,
        {}
      );
    },
    onSuccess: (_, connectionId) => {
      qc.invalidateQueries({ queryKey: integrationKeys.connection(connectionId) });
      qc.invalidateQueries({ queryKey: integrationKeys.connections() });
    },
  });
}

export function useDisconnectIntegration() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      const client = await getClient();
      // app-api DELETE returns 204 No Content (legacy returned {message}).
      await client.delete<void>(`/integrations/connections/${connectionId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: integrationKeys.connections() });
    },
  });
}

// =============================================================================
// Update Connection Settings
// =============================================================================

export function useUpdateConnectionSettings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      connectionId,
      ...body
    }: {
      connectionId: string;
      name?: string;
      syncSettings?: {
        syncCompanies?: boolean;
        syncPeople?: boolean;
        syncLeads?: boolean;
        syncOpportunities?: boolean;
        syncActivities?: boolean;
        syncIntervalHours?: number;
      };
    }) => {
      const client = await getClient();
      return client.patch<{ data: { id: string; updated: boolean } }>(
        `/integrations/connections/${connectionId}`,
        body
      );
    },
    onSuccess: (_, { connectionId }) => {
      qc.invalidateQueries({ queryKey: integrationKeys.connection(connectionId) });
      qc.invalidateQueries({ queryKey: integrationKeys.connections() });
    },
  });
}

// =============================================================================
// Generic OAuth (provider-agnostic)
// =============================================================================

export function useConnectProvider() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({ provider, redirectUri }: { provider: string; redirectUri: string }) => {
      const client = await getClient();
      return client.post<{ data: { authorizeUrl: string; state: string } }>(
        `/integrations/connections/${provider}/authorize`,
        { redirectUri }
      );
    },
  });
}

export function useProviderCallback() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ provider, ...params }: { provider: string; code: string; state: string; redirectUri: string }) => {
      const client = await getClient();
      return client.post<{ data: { id: string; provider: string; status: string } }>(
        `/integrations/connections/${provider}/callback`,
        params
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: integrationKeys.connections() });
    },
  });
}

// =============================================================================
// Field Mappings
// =============================================================================

export interface FieldMapping {
  id: string;
  connectionId: string;
  entityType: string;
  externalFieldPath: string;
  internalFieldPath: string;
  direction: 'inbound' | 'outbound' | 'bidirectional';
  transformType: 'direct' | 'lookup' | 'format_date' | 'custom';
  transformConfig: Record<string, unknown> | null;
  isRequired: boolean;
  isDefault: boolean;
  position: number;
}

export interface FieldMappingDefinition {
  externalFieldPath: string;
  internalFieldPath: string;
  direction: 'inbound' | 'outbound' | 'bidirectional';
  transformType: 'direct' | 'lookup' | 'format_date' | 'custom';
  transformConfig?: Record<string, unknown>;
  isRequired?: boolean;
}

export function useFieldMappings(connectionId: string, entityType?: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: integrationKeys.fieldMappings(connectionId, entityType),
    queryFn: async () => {
      const client = await getClient();
      const params = entityType ? `?entityType=${entityType}` : '';
      return client.get<{ data: FieldMapping[] }>(
        `/integrations/connections/${connectionId}/field-mappings${params}`
      );
    },
    enabled: !!connectionId,
  });
}

export function useDefaultFieldMappings(connectionId: string, entityType: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: integrationKeys.defaultFieldMappings(connectionId, entityType),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: FieldMappingDefinition[] }>(
        `/integrations/connections/${connectionId}/field-mappings/defaults?entityType=${entityType}`
      );
    },
    enabled: !!connectionId && !!entityType,
  });
}

export function useUpdateFieldMappings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      connectionId,
      entityType,
      mappings,
    }: {
      connectionId: string;
      entityType: string;
      mappings: Omit<FieldMappingDefinition, 'isRequired'>[];
    }) => {
      const client = await getClient();
      return client.put<{ data: { entityType: string; count: number } }>(
        `/integrations/connections/${connectionId}/field-mappings`,
        { entityType, mappings }
      );
    },
    onSuccess: (_, { connectionId, entityType }) => {
      qc.invalidateQueries({ queryKey: integrationKeys.fieldMappings(connectionId, entityType) });
    },
  });
}

// =============================================================================
// Sync Conflicts
// =============================================================================

export interface SyncConflict {
  id: string;
  connectionId: string;
  entityType: string;
  internalEntityId: string;
  externalEntityId: string;
  conflictType: string;
  internalData: Record<string, unknown>;
  externalData: Record<string, unknown>;
  conflictFields: string[] | null;
  resolution: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
}

export function useSyncConflicts(
  connectionId: string,
  filters?: { resolution?: string; entityType?: string },
) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: integrationKeys.conflicts(connectionId, filters),
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams();
      if (filters?.resolution) params.set('resolution', filters.resolution);
      if (filters?.entityType) params.set('entityType', filters.entityType);
      const qs = params.toString();
      return client.get<{ data: SyncConflict[] }>(
        `/integrations/connections/${connectionId}/conflicts${qs ? `?${qs}` : ''}`
      );
    },
    enabled: !!connectionId,
  });
}

export function useResolveConflict() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      connectionId,
      conflictId,
      resolution,
    }: {
      connectionId: string;
      conflictId: string;
      resolution: 'keep_internal' | 'keep_external' | 'merged' | 'dismissed';
    }) => {
      const client = await getClient();
      return client.post<{ data: { resolved: boolean } }>(
        `/integrations/connections/${connectionId}/conflicts/${conflictId}/resolve`,
        { resolution }
      );
    },
    onSuccess: (_, { connectionId }) => {
      qc.invalidateQueries({ queryKey: integrationKeys.conflicts(connectionId) });
    },
  });
}

function useBulkResolveConflicts() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      connectionId,
      resolution,
      entityType,
    }: {
      connectionId: string;
      resolution: 'keep_internal' | 'keep_external' | 'dismissed';
      entityType?: string;
    }) => {
      const client = await getClient();
      return client.post<{ data: { resolved: boolean } }>(
        `/integrations/connections/${connectionId}/conflicts/resolve-all`,
        { resolution, entityType }
      );
    },
    onSuccess: (_, { connectionId }) => {
      qc.invalidateQueries({ queryKey: integrationKeys.conflicts(connectionId) });
    },
  });
}

// =============================================================================
// Entity Sync Status (for badges on CRM record pages)
// =============================================================================

interface EntitySyncMapping {
  id: string;
  connectionId: string;
  externalEntityType: string;
  externalEntityId: string;
  internalEntityType: string;
  internalEntityId: string;
  lastSyncedAt: string | null;
  syncChecksum: string | null;
}

function useEntitySyncStatus(entityType: string, entityId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: integrationKeys.entitySyncStatus(entityType, entityId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: EntitySyncMapping[] }>(
        `/integrations/entity-mappings?internalEntityType=${entityType}&internalEntityId=${entityId}`
      );
    },
    enabled: !!entityType && !!entityId,
  });
}
