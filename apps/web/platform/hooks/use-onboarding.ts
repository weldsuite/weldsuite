
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

const onboardingKeys = {
  all: ['onboarding'] as const,
  status: () => [...onboardingKeys.all, 'status'] as const,
  databaseStatus: () => [...onboardingKeys.all, 'database-status'] as const,
  userInfo: () => [...onboardingKeys.all, 'user-info'] as const,
  availableApps: () => [...onboardingKeys.all, 'available-apps'] as const,
};

interface OnboardingStatusData {
  completed: boolean;
  hasOrganization: boolean;
}

interface DatabaseStatusData {
  provisioned: boolean;
  migrated: boolean;
  /** 'pending' | 'provisioning' | 'ready' | 'failed' — present on newer API responses. */
  status?: 'pending' | 'provisioning' | 'ready' | 'failed';
  /** True when provisioning terminally failed and the user should retry. */
  failed?: boolean;
}

interface UserInfoData {
  user: {
    firstName: string;
    lastName: string;
    email: string;
    imageUrl?: string;
  };
  organization: {
    id: string;
    name: string;
  } | null;
}

interface AppDefinition {
  code: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  path: string;
  overview?: string | null;
  features?: string[];
  howItWorks?: { title: string; description: string }[];
  version?: string;
  provider?: string | null;
}

export function useOnboardingStatus() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: onboardingKeys.status(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: OnboardingStatusData }>('/onboarding/status');
      return result.data;
    },
  });
}

export function useDatabaseStatus(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: onboardingKeys.databaseStatus(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: DatabaseStatusData }>('/onboarding/database-status');
      return result.data;
    },
    enabled,
    refetchInterval: 2000,
  });
}

export function useUserAndOrgInfo(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: onboardingKeys.userInfo(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: UserInfoData }>('/onboarding/user-info');
      return result.data;
    },
    enabled,
  });
}

export function useAvailableApps() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: onboardingKeys.availableApps(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: AppDefinition[] }>('/onboarding/available-apps');
      return result.data || [];
    },
  });
}

export function useCompleteOnboarding() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const client = await getClient();
      return client.post<{ data: { success: boolean; clerkOrgId?: string; workspaceId?: string } }>('/onboarding/complete', data);
    },
  });
}

/**
 * Create an ADDITIONAL workspace from within the platform. Goes through the same
 * server-side path as the onboarding wizard (app-api → workspace-worker /api/onboard)
 * so the new workspace is created + provisioned identically — default apps installed,
 * sample data skipped, single provisioning trigger. Returns the new org + workspace ids.
 */
export function useCreateWorkspace() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (input: { name: string; region?: string; selectedApps?: string[] }) => {
      const client = await getClient();
      const result = await client.post<{
        data: {
          success: boolean;
          organizationId?: string;
          workspaceId?: string;
          /** True when the workspace was provisioned instantly from a warm
           *  pre-migrated database slot — no polling needed, switch right away. */
          ready?: boolean;
        };
      }>('/onboarding/create-workspace', input);
      return result.data;
    },
  });
}

export function useRetryProvisioning() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      return client.post<{ data: { success: boolean } }>('/onboarding/retry', {});
    },
  });
}

export function useFinalizeOnboarding() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      return client.post<{ data: { success: boolean } }>('/onboarding/finalize', {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: onboardingKeys.all });
    },
  });
}
