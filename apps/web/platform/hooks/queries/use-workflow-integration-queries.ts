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
  slackChannels: (id: string | undefined) =>
    [...workflowIntegrationKeys.all, 'slack-channels', id] as const,
  githubRepos: (id: string | undefined) =>
    [...workflowIntegrationKeys.all, 'github-repos', id] as const,
  googleSpreadsheet: (id: string | undefined, spreadsheetIdOrUrl: string | undefined) =>
    [...workflowIntegrationKeys.all, 'google-spreadsheet', id, spreadsheetIdOrUrl] as const,
  googleCalendars: (id: string | undefined) =>
    [...workflowIntegrationKeys.all, 'google-calendars', id] as const,
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
  kind: 'oauth2' | 'api_key' | 'app_installation';
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

export interface SlackChannelOption {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

/** Channels the connected Slack app can see — the `slack.post_message` step
 *  form's channel picker (`conversations.list`, via connect-api). */
export function useSlackChannels(integrationId: string | undefined) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: workflowIntegrationKeys.slackChannels(integrationId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: SlackChannelOption[] }>(
        `/workflow-integrations/${integrationId}/slack/channels`,
      );
    },
    enabled: !!integrationId,
  });
}

export interface GithubRepoOption {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

/** Repositories the connected GitHub App installation can see — the
 *  `github.create_issue` / `github.create_comment` step forms' repo picker
 *  (`installation/repositories`, via connect-api). */
export function useGithubRepos(integrationId: string | undefined) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: workflowIntegrationKeys.githubRepos(integrationId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: GithubRepoOption[] }>(
        `/workflow-integrations/${integrationId}/github/repos`,
      );
    },
    enabled: !!integrationId,
  });
}

export interface GoogleSheetTab {
  sheetId: number;
  title: string;
}

export interface GoogleSpreadsheetInfo {
  spreadsheetId: string;
  title: string;
  url: string;
  sheets: GoogleSheetTab[];
}

/**
 * Resolves a pasted spreadsheet id/URL to its title + sheet tabs — backs both
 * the spreadsheet field (validation) and the sheet-tab picker in the
 * google_sheets.append_row / update_row step forms. No Drive scope is
 * requested (see connect-api's services/workflow-integrations/google.ts), so
 * there is no "browse my Drive" picker — the id/URL is pasted, not selected.
 */
export function useGoogleSpreadsheet(integrationId: string | undefined, spreadsheetIdOrUrl: string | undefined) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: workflowIntegrationKeys.googleSpreadsheet(integrationId, spreadsheetIdOrUrl),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: GoogleSpreadsheetInfo }>(
        `/workflow-integrations/${integrationId}/google_sheets/spreadsheet?spreadsheetId=${encodeURIComponent(spreadsheetIdOrUrl ?? '')}`,
      );
    },
    enabled: !!integrationId && !!spreadsheetIdOrUrl,
    retry: false,
  });
}

export interface GoogleCalendarOption {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}

/** Calendars the connected Google account can write to — the
 *  google_calendar.create_event step form's calendar picker. */
export function useGoogleCalendars(integrationId: string | undefined) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: workflowIntegrationKeys.googleCalendars(integrationId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: GoogleCalendarOption[] }>(
        `/workflow-integrations/${integrationId}/google_calendar/calendars`,
      );
    },
    enabled: !!integrationId,
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

/**
 * Point WeldConnect's `github` integration at the workspace's existing
 * GitHub App installation (WeldFlow's project sync, Settings → Integrations
 * → GitHub) — no OAuth redirect, unlike `useConnectWorkflowProvider`. When no
 * installation exists yet, the response comes back `status: 'needs_install'`
 * instead of `'connected'`; the caller is responsible for sending the member
 * to Settings → Integrations → GitHub to install the App first.
 */
export function useLinkGithubInstallation() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      return client.post<{
        data: { status: 'connected' | 'needs_install'; id?: string; provider: 'github' };
      }>('/workflow-integrations/github/link', {});
    },
    onSuccess: (result) => {
      if (result.data.status === 'connected') {
        qc.invalidateQueries({ queryKey: workflowIntegrationKeys.list() });
      }
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
