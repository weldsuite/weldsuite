
import { useQuery } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

export const workflowEditorKeys = {
  all: ['workflow-editor'] as const,
  workflow: (id: string) => [...workflowEditorKeys.all, 'workflow', id] as const,
  actionTypes: () => [...workflowEditorKeys.all, 'action-types'] as const,
  triggerTypes: () => [...workflowEditorKeys.all, 'trigger-types'] as const,
  entityEvents: () => [...workflowEditorKeys.all, 'entity-events'] as const,
  emailAccounts: () => [...workflowEditorKeys.all, 'email-accounts'] as const,
  workspaceMembers: () => [...workflowEditorKeys.all, 'workspace-members'] as const,
  workflowVariables: (workflowId: string) => [...workflowEditorKeys.all, 'workflow-variables', workflowId] as const,
  workflowsForChaining: (excludeId?: string) => [...workflowEditorKeys.all, 'workflows-for-chaining', excludeId] as const,
  workflowWebhook: (workflowId: string) => [...workflowEditorKeys.all, 'workflow-webhook', workflowId] as const,
};

export function useWorkflowDetail(id: string, options?: { enabled?: boolean; module?: 'task' | 'helpdesk' }) {
  const { getClient } = useAppApiClient();
  const enabled = options?.enabled ?? true;
  // Both surfaces are app-api now; they differ only in the mount path.
  const isHelpdesk = options?.module === 'helpdesk';
  const basePath = isHelpdesk ? '/helpdesk-workflows' : '/workflows';
  return useQuery({
    queryKey: [...workflowEditorKeys.workflow(id), options?.module ?? 'task'],
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: any }>(`${basePath}/${id}`);
      return result.data || null;
    },
    enabled: !!id && enabled,
  });
}

export function useActionTypes() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: workflowEditorKeys.actionTypes(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: any[] }>('/workflow-dashboard/action-types');
      return result.data || [];
    },
  });
}

export function useTriggerTypes() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: workflowEditorKeys.triggerTypes(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: any[] }>('/workflow-dashboard/trigger-types');
      return result.data || [];
    },
  });
}

export function useEntityEvents() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: workflowEditorKeys.entityEvents(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: any[] }>('/workflow-dashboard/entity-events');
      return result.data || [];
    },
  });
}

export function useEmailAccounts() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: workflowEditorKeys.emailAccounts(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: any[] }>('/mail-accounts?status=active');
      const accounts = result.data || [];
      return accounts.map((account: any) => ({
        id: account.id,
        email: account.email,
        displayName: account.displayName || account.name || undefined,
      }));
    },
  });
}

export function useEditorWorkspaceMembers() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: workflowEditorKeys.workspaceMembers(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: any[] }>('/team-members?limit=100');
      const members = result.data || [];
      return members
        .filter((member: any) => {
          const status = (member.status || '').toUpperCase();
          return status !== 'PENDING';
        })
        .map((member: any) => ({
          id: member.userId || member.id,
          name: member.name || member.email?.split('@')[0] || 'Unknown',
          email: member.email || '',
          avatar: member.picture || undefined,
        }));
    },
  });
}

export function useWorkflowVariables(workflowId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: workflowEditorKeys.workflowVariables(workflowId),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: any[] }>(`/workflow-variables/workflow/${workflowId}`);
      return result.data || [];
    },
    enabled: !!workflowId && enabled,
  });
}

function useWorkflowsForChaining(excludeId?: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: workflowEditorKeys.workflowsForChaining(excludeId),
    queryFn: async () => {
      const client = await getClient();
      const query = excludeId ? `?exclude=${excludeId}` : '';
      const result = await client.get<{ data: Array<{ id: string; name: string; status: string }> }>(`/workflows/for-chaining${query}`);
      return result.data || [];
    },
  });
}

function useWorkflowWebhook(workflowId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: workflowEditorKeys.workflowWebhook(workflowId),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: any }>(`/workflow-webhooks/workflow/${workflowId}`);
      return result.data || null;
    },
    enabled: !!workflowId && enabled,
  });
}

/**
 * Aggregator for the workflow editor page. Composes the nine individual editor
 * data queries into one object so consumers (WeldConnect workflows + WeldCRM
 * sequences) don't each duplicate the same nine `useX()` calls and the
 * combined `isLoading` reduction. Individual hooks remain exported for callers
 * that need a single slice (templates, WeldDesk).
 */
export function useWorkflowEditorData(id: string) {
  const workflow = useWorkflowDetail(id);
  const actionTypes = useActionTypes();
  const triggerTypes = useTriggerTypes();
  const entityEvents = useEntityEvents();
  const emailAccounts = useEmailAccounts();
  const workspaceMembers = useEditorWorkspaceMembers();
  const workflowVariables = useWorkflowVariables(id);
  const workflowsForChaining = useWorkflowsForChaining(id);
  const webhookData = useWorkflowWebhook(id);

  const isLoading =
    workflow.isLoading ||
    actionTypes.isLoading ||
    triggerTypes.isLoading ||
    entityEvents.isLoading ||
    emailAccounts.isLoading ||
    workspaceMembers.isLoading ||
    workflowVariables.isLoading ||
    workflowsForChaining.isLoading ||
    webhookData.isLoading;

  return {
    workflow: workflow.data,
    actionTypes: actionTypes.data ?? [],
    triggerTypes: triggerTypes.data ?? [],
    entityEvents: entityEvents.data ?? [],
    emailAccounts: emailAccounts.data,
    workspaceMembers: workspaceMembers.data,
    workflowVariables: workflowVariables.data,
    workflowsForChaining: workflowsForChaining.data,
    webhookData: webhookData.data,
    isLoading,
    isError: workflow.isError,
    // Expose the workflow query's error + refetch so the editor page can show a
    // real error state with a Retry (instead of throwing notFound() and hitting
    // the blank root error boundary on a transient failure — e.g. a request that
    // fired before Clerk finished bootstrapping the token on a hard refresh).
    error: workflow.error,
    // `!workflow` with no error means the fetch succeeded but returned nothing —
    // a genuine "not found", distinct from a request failure.
    isNotFound: !workflow.isLoading && !workflow.isError && !workflow.data,
    refetch: workflow.refetch,
  };
}
