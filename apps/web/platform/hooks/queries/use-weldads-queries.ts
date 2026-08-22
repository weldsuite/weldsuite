import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { DataResponse, ListResponse } from '@weldsuite/core-api-client/types';
import { buildQueryString } from '@weldsuite/core-api-client/types';

export interface AdPlatformConnection {
  id: string;
  platform: 'facebook' | 'google';
  status: 'active' | 'error' | 'pending_reauth';
  metaUserId?: string | null;
  metaUserName?: string | null;
  tokenExpiresAt?: string | null;
  lastSyncAt?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdAccount {
  id: string;
  connectionId: string;
  platformAccountId: string;
  name: string;
  currency?: string | null;
  timezone?: string | null;
  status?: string | null;
  isSelected: boolean;
}

export interface AdCampaignRow {
  id: string;
  adAccountId: string;
  platformCampaignId: string;
  name: string;
  status?: string | null;
  objective?: string | null;
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
  currency?: string | null;
  metrics?: {
    spend?: string;
    impressions?: string;
    clicks?: string;
    ctr?: string;
    cpc?: string;
    reach?: string;
  } | null;
  metricsSyncedAt?: string | null;
  syncStatus?: 'local' | 'pending_push' | 'synced' | 'error' | null;
  syncError?: string | null;
  lastSyncedAt?: string | null;
  accountName?: string;
  platformAccountId?: string;
}

export const weldadsKeys = {
  all: ['weldads'] as const,
  connections: () => [...weldadsKeys.all, 'connections'] as const,
  accounts: (connectionId?: string) => [...weldadsKeys.all, 'accounts', connectionId ?? 'all'] as const,
  campaigns: (params?: Record<string, unknown>) => [...weldadsKeys.all, 'campaigns', params ?? {}] as const,
};

export function useWeldAdsConnections() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldadsKeys.connections(),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<DataResponse<AdPlatformConnection[]>>('/ad-connections');
      return res.data;
    },
  });
}

export function useWeldAdsAccounts(connectionId?: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldadsKeys.accounts(connectionId),
    enabled: !!connectionId,
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString({ connectionId });
      const res = await client.get<DataResponse<AdAccount[]>>(`/ad-accounts${qs}`);
      return res.data;
    },
  });
}

export function useWeldAdsCampaigns(params?: { limit?: number; adAccountId?: string }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: weldadsKeys.campaigns(params),
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString(params ?? {});
      return client.get<ListResponse<AdCampaignRow>>(`/ad-campaigns${qs}`);
    },
  });
}

export function useWeldAdsAuthorizeFacebook() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      const res = await client.post<DataResponse<{ authorizeUrl: string; state: string }>>(
        '/ad-connections/facebook/authorize',
      );
      return res.data;
    },
  });
}

export function useCompleteWeldAdsFacebookOAuth() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { code: string; state: string }) => {
      const client = await getClient();
      const res = await client.post<DataResponse<{ id: string }>>('/ad-connections/facebook/callback', input);
      return res.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: weldadsKeys.all });
    },
  });
}

export function useUpdateWeldAdsAccount() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; isSelected: boolean }) => {
      const client = await getClient();
      const res = await client.patch<DataResponse<AdAccount>>(`/ad-accounts/${input.id}`, {
        isSelected: input.isSelected,
      });
      return res.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: weldadsKeys.all });
    },
  });
}

export function useSyncWeldAdsConnection() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { connectionId: string; scope?: 'full' | 'push' | 'pull' | 'metrics' }) => {
      const client = await getClient();
      const scope = input.scope === 'metrics' ? 'pull' : input.scope;
      const qs = scope ? buildQueryString({ scope }) : '';
      return client.post<DataResponse<{ syncedCampaigns: number; writtenCampaigns: number; pushed: number; failed: number; pulled: number }>>(
        `/ad-connections/${input.connectionId}/sync${qs}`,
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: weldadsKeys.all });
    },
  });
}

export function useDeleteWeldAdsConnection() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      const client = await getClient();
      await client.delete(`/ad-connections/${connectionId}`);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: weldadsKeys.all });
    },
  });
}

export type AdCampaignObjective =
  | 'OUTCOME_TRAFFIC'
  | 'OUTCOME_SALES'
  | 'OUTCOME_LEADS'
  | 'OUTCOME_AWARENESS'
  | 'OUTCOME_ENGAGEMENT'
  | 'OUTCOME_APP_PROMOTION';

export type AdCampaignStatus = 'ACTIVE' | 'PAUSED';

export interface CreateAdCampaignInput {
  adAccountId: string;
  name: string;
  objective: AdCampaignObjective;
  status?: AdCampaignStatus;
  dailyBudget?: number;
  lifetimeBudget?: number;
}

export interface UpdateAdCampaignInput {
  name?: string;
  objective?: AdCampaignObjective;
  status?: AdCampaignStatus;
  dailyBudget?: number;
  lifetimeBudget?: number;
}

export function useCreateWeldAdsCampaign() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateAdCampaignInput) => {
      const client = await getClient();
      const res = await client.post<DataResponse<AdCampaignRow>>('/ad-campaigns', input);
      return res.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: weldadsKeys.all });
    },
  });
}

export function useUpdateWeldAdsCampaign() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string } & UpdateAdCampaignInput) => {
      const client = await getClient();
      const { id, ...body } = input;
      const res = await client.patch<DataResponse<AdCampaignRow>>(`/ad-campaigns/${id}`, body);
      return res.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: weldadsKeys.all });
    },
  });
}
