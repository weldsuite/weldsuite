import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

// =============================================================================
// Types
// =============================================================================

interface ChecklistTask {
  key: string;
  appCode: string | null; // null = general/workspace task
  href: string;
}

interface OnboardingChecklistResponse {
  dismissedApps: string[];
  items: Record<string, boolean>;
}

export interface AppChecklistItem {
  key: string;
  href: string;
  completed: boolean;
}

// =============================================================================
// Task Definitions
// =============================================================================

const CHECKLIST_TASKS: ChecklistTask[] = [
  // General workspace tasks
  { key: 'workspace_member_invited', appCode: null, href: '/settings/team' },
  { key: 'workspace_logo_uploaded', appCode: null, href: '/settings/business' },
  // CRM
  { key: 'crm_customer_created', appCode: 'weldcrm', href: '/weldcrm/companies?new=1' },
  { key: 'crm_contact_created', appCode: 'weldcrm', href: '/weldcrm/people?new=1' },
  { key: 'crm_note_created', appCode: 'weldcrm', href: '/weldcrm/notes?new=1' },
  { key: 'crm_task_created', appCode: 'weldcrm', href: '/weldcrm?new=1' },
  // Helpdesk
  { key: 'helpdesk_department_created', appCode: 'welddesk', href: '/welddesk/chat-widget' },
  // Mail
  { key: 'mail_account_connected', appCode: 'weldmail', href: '/settings/apps/weldmail' },
  // Projects
  { key: 'project_created', appCode: 'weldflow', href: '/weldflow' },
  // Task
  { key: 'task_created', appCode: 'weldconnect', href: '/weldconnect' },
  // Host
  { key: 'host_domain_added', appCode: 'weldhost', href: '/weldhost/domains' },
  // Parcel
  { key: 'parcel_carrier_configured', appCode: 'parcel', href: '/parcel/settings/carriers' },
  // WMS
  { key: 'wms_warehouse_added', appCode: 'wms', href: '/wms/warehouses' },
  // Accounting
  { key: 'accounting_chart_setup', appCode: 'weldbooks', href: '/weldbooks/accounts' },
  // Social
  { key: 'social_account_connected', appCode: 'social', href: '/social/accounts' },
];

// =============================================================================
// Query Keys
// =============================================================================

const onboardingChecklistKeys = {
  all: ['onboarding-checklist'] as const,
  data: () => [...onboardingChecklistKeys.all, 'data'] as const,
  memberLimit: () => [...onboardingChecklistKeys.all, 'member-limit'] as const,
};

/** The task that cannot be done on a plan limited to a single member. */
const INVITE_TASK_KEY = 'workspace_member_invited';

/**
 * The tasks shown for an app module: its own plus the general workspace tasks
 * (CRM shows only its own, with no workspace-level tasks). "Invite a team
 * member" is left out when the workspace is capped at one seat (the Free plan),
 * so it neither shows as a step nor counts toward completion.
 */
export function checklistTasksFor(
  appCode: string,
  { seatLimit }: { seatLimit: number | null | undefined },
): ChecklistTask[] {
  const canInvite = seatLimit !== 1;
  return CHECKLIST_TASKS.filter((task) => {
    if (task.key === INVITE_TASK_KEY && !canInvite) return false;
    return appCode === 'weldcrm' ? task.appCode === 'weldcrm' : task.appCode === appCode || task.appCode === null;
  });
}

/**
 * Marks the checklist stale so the Getting Started card ticks off an item as
 * soon as the record behind it is created (call from create-mutation hooks).
 */
export function invalidateOnboardingChecklist(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: onboardingChecklistKeys.all });
}

// =============================================================================
// Hooks
// =============================================================================

/**
 * Fetches onboarding checklist completion state from the API.
 * Cached for 60 seconds to avoid excessive re-fetching.
 */
function useOnboardingChecklist() {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: onboardingChecklistKeys.data(),
    queryFn: async (): Promise<OnboardingChecklistResponse> => {
      const client = await getClient();
      const res = await client.get<{ data: OnboardingChecklistResponse }>(
        '/dashboard/onboarding-checklist',
      );
      return res?.data || { dismissedApps: [], items: {} };
    },
    staleTime: 60_000,
    // Items can be completed in another tab or by a teammate.
    refetchOnWindowFocus: true,
  });
}

/**
 * The workspace's enforced member limit (app-api `/member-limits`, the same
 * number Invite Member checks). `null` when the plan is unlimited.
 */
function useChecklistSeatLimit() {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: onboardingChecklistKeys.memberLimit(),
    queryFn: async (): Promise<number | null> => {
      const client = await getClient();
      const res = await client.get<{ data?: { limit: number | null } }>('/member-limits');
      return res?.data?.limit ?? null;
    },
    staleTime: 60_000,
  });
}

/**
 * Mutation to dismiss the onboarding checklist for a specific app.
 * Optimistically updates the cache so the UI hides immediately.
 */
export function useDismissOnboardingChecklist() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (appCode: string) => {
      const client = await getClient();
      await client.post('/dashboard/onboarding-checklist/dismiss', { appCode });
    },
    onMutate: async (appCode: string) => {
      await queryClient.cancelQueries({ queryKey: onboardingChecklistKeys.data() });
      const previous = queryClient.getQueryData<OnboardingChecklistResponse>(
        onboardingChecklistKeys.data()
      );
      if (previous) {
        queryClient.setQueryData<OnboardingChecklistResponse>(
          onboardingChecklistKeys.data(),
          {
            ...previous,
            dismissedApps: [...previous.dismissedApps, appCode],
          }
        );
      }
      return { previous };
    },
    onError: (_err, _appCode, context) => {
      if (context?.previous) {
        queryClient.setQueryData(onboardingChecklistKeys.data(), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: onboardingChecklistKeys.data() });
    },
  });
}

/**
 * Returns checklist items for a specific app module, including general tasks.
 * Returns null if the checklist should not be shown (dismissed or all completed or no data yet).
 */
export function useAppChecklistItems(appCode: string | null) {
  const { data, isLoading } = useOnboardingChecklist();
  const { data: seatLimit, isLoading: seatLimitLoading } = useChecklistSeatLimit();

  // Wait for the seat limit too: otherwise a Free workspace would flash an
  // "Invite a team member" step it cannot complete.
  if (!appCode || isLoading || seatLimitLoading || !data) {
    return null;
  }

  // Check if this app's checklist was dismissed
  if (data.dismissedApps.includes(appCode)) {
    return null;
  }

  // Get tasks for this app + general tasks (CRM shows only its own — no workspace-level tasks)
  const tasks = checklistTasksFor(appCode, { seatLimit });

  const items: AppChecklistItem[] = tasks.map((task) => ({
    key: task.key,
    href: task.href,
    completed: !!data.items[task.key],
  }));

  // Auto-hide if all completed
  if (items.length > 0 && items.every((item) => item.completed)) {
    return null;
  }

  return items;
}
