import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

// =============================================================================
// Query Keys
// =============================================================================

const workflowIntegrationKeys = {
  all: ['workflow-integrations'] as const,
  catalog: () => [...workflowIntegrationKeys.all, 'catalog'] as const,
  list: (filters?: WorkflowIntegrationFilters) =>
    [...workflowIntegrationKeys.all, 'list', filters] as const,
  detail: (id: string) => [...workflowIntegrationKeys.all, 'detail', id] as const,
};

// =============================================================================
// Types
// =============================================================================

interface ActionDef {
  id: string;
  name: string;
  description?: string;
}

interface TriggerDef {
  id: string;
  name: string;
  description?: string;
}

interface IntegrationAuth {
  kind: 'oauth2' | 'api_key';
  [key: string]: unknown;
}

export interface IntegrationDef {
  id: string;
  type: string;
  label: string;
  description: string;
  category: string;
  icon: string;
  auth: IntegrationAuth;
  actions: ActionDef[];
  triggers: TriggerDef[];
}

export interface WorkflowIntegration {
  id: string;
  name: string;
  type: string;
  category: string;
  icon: string;
  status: string;
  hasCredentials: boolean;
  hasOauthTokens: boolean;
  connectedAt: string | null;
  lastError: string | null;
}

export interface WorkflowIntegrationFilters {
  type?: string;
  status?: string;
  category?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface WorkflowIntegrationListResponse {
  data: WorkflowIntegration[];
  pagination: {
    totalCount: number;
    hasMore: boolean;
    cursor: string | null;
  };
}

// =============================================================================
// Queries
// =============================================================================

export function useIntegrationCatalog() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: workflowIntegrationKeys.catalog(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: IntegrationDef[] }>('/workflow-integrations/catalog');
    },
  });
}

export function useWorkflowIntegrations(filters?: WorkflowIntegrationFilters) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: workflowIntegrationKeys.list(filters),
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams();
      if (filters?.type) params.set('type', filters.type);
      if (filters?.status) params.set('status', filters.status);
      if (filters?.category) params.set('category', filters.category);
      if (filters?.search) params.set('search', filters.search);
      if (filters?.cursor) params.set('cursor', filters.cursor);
      if (filters?.limit) params.set('limit', String(filters.limit));
      const qs = params.toString();
      return client.get<WorkflowIntegrationListResponse>(
        `/workflow-integrations${qs ? `?${qs}` : ''}`,
      );
    },
  });
}

// =============================================================================
// Mutations
// =============================================================================

export function useConnectWorkflowProvider() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async ({
      provider,
      integrationId,
    }: {
      provider: string;
      integrationId?: string;
    }) => {
      const client = await getClient();
      const result = await client.post<{
        data: { authorizeUrl: string; state: string };
      }>(`/workflow-integrations/${provider}/authorize`, {
        ...(integrationId ? { integrationId } : {}),
      });
      // Store provider in sessionStorage so the callback page can read it
      sessionStorage.setItem('wf_oauth_provider', provider);
      // Redirect to OAuth authorisation URL
      window.location.href = result.data.authorizeUrl;
      return result;
    },
  });
}

export function useWorkflowProviderCallback() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      provider,
      code,
      state,
    }: {
      provider: string;
      code: string;
      state: string;
    }) => {
      const client = await getClient();
      return client.post<{
        data: { id: string; status: string; provider: string };
      }>(`/workflow-integrations/${provider}/callback`, { code, state });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workflowIntegrationKeys.list() });
    },
  });
}

function useConnectWorkflowApiKey() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      provider,
      credentials,
    }: {
      provider: string;
      credentials: Record<string, string>;
    }) => {
      const client = await getClient();
      return client.post<{
        data: { id: string; status: string; provider: string };
      }>(`/workflow-integrations/${provider}/apikey`, { credentials });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workflowIntegrationKeys.list() });
    },
  });
}

export function useDisconnectWorkflowIntegration() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.patch<{ data: { id: string; status: string } }>(
        `/workflow-integrations/${id}/disconnect`,
        {},
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workflowIntegrationKeys.list() });
    },
  });
}

export function useTestWorkflowIntegration() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<{ data: { success: boolean; message: string } }>(
        `/workflow-integrations/${id}/test`,
        {},
      );
    },
  });
}
