/**
 * Social query + mutation hooks.
 *
 * Backed by the unified app-api (`apps/workers/app-api`). Every hook resolves
 * to a typed domain client from `@weldsuite/app-api-client` via
 * `useAppApi()`.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type { SocialPlatform } from '@weldsuite/app-api-client/domains/social';

// =============================================================================
// Query keys
// =============================================================================

const socialKeys = {
  all: ['social'] as const,
  accounts: () => [...socialKeys.all, 'accounts'] as const,
  posts: (params?: Record<string, unknown>) => [...socialKeys.all, 'posts', params] as const,
  post: (id: string) => [...socialKeys.all, 'posts', id] as const,
  campaigns: () => [...socialKeys.all, 'campaigns'] as const,
  campaign: (id: string) => [...socialKeys.all, 'campaigns', id] as const,
  media: () => [...socialKeys.all, 'media'] as const,
  approvals: (params?: Record<string, unknown>) => [...socialKeys.all, 'approvals', params] as const,
  team: () => [...socialKeys.all, 'team'] as const,
  stats: () => [...socialKeys.all, 'stats'] as const,
  analyticsOverview: () => [...socialKeys.all, 'analytics', 'overview'] as const,
  settings: () => [...socialKeys.all, 'settings'] as const,
  timezones: () => [...socialKeys.all, 'settings', 'timezones'] as const,
};

// =============================================================================
// Analytics
// =============================================================================

export function useSocialDashboardStats() {
  const { social } = useAppApi();
  return useQuery({
    queryKey: socialKeys.stats(),
    queryFn: () => social.analytics.stats(),
  });
}

export function useSocialAnalyticsOverview() {
  const { social } = useAppApi();
  return useQuery({
    queryKey: socialKeys.analyticsOverview(),
    queryFn: () => social.analytics.overview(),
  });
}

// =============================================================================
// Posts
// =============================================================================

export function useSocialPosts(params?: Record<string, unknown>) {
  const { social } = useAppApi();
  return useQuery({
    queryKey: socialKeys.posts(params),
    queryFn: () => social.posts.list(params),
  });
}

function useSocialPost(id: string) {
  const { social } = useAppApi();
  return useQuery({
    queryKey: socialKeys.post(id),
    queryFn: () => social.posts.get(id),
    enabled: !!id,
  });
}

export function useCreateSocialPost() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => social.posts.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.posts() });
    },
  });
}

export function useUpdateSocialPost() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Record<string, unknown>) =>
      social.posts.update(id, data),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: socialKeys.post(id) });
      qc.invalidateQueries({ queryKey: socialKeys.posts() });
    },
  });
}

export function useDeleteSocialPost() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => social.posts.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.posts() });
    },
  });
}

export function usePublishSocialPost() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => social.posts.publish(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.posts() });
    },
  });
}

export function useScheduleSocialPost() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, scheduledAt, timezone }: { id: string; scheduledAt: string; timezone?: string }) =>
      social.posts.schedule(id, scheduledAt, timezone),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.posts() });
    },
  });
}

export function useRescheduleSocialPost() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, scheduledAt, timezone }: { id: string; scheduledAt: string; timezone?: string }) =>
      social.posts.reschedule(id, scheduledAt, timezone),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.posts() });
    },
  });
}

export function useCancelSocialPost() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => social.posts.cancel(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.posts() });
    },
  });
}

// =============================================================================
// Accounts
// =============================================================================

export function useSocialAccounts() {
  const { social } = useAppApi();
  return useQuery({
    queryKey: socialKeys.accounts(),
    queryFn: () => social.accounts.list(),
  });
}

export function useConnectSocialAccount() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ platform, redirectUri }: { platform: SocialPlatform; redirectUri?: string }) =>
      social.accounts.connect(platform, redirectUri),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.accounts() });
    },
  });
}

export function useDisconnectSocialAccount() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => social.accounts.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.accounts() });
    },
  });
}

export function useSyncSocialAccounts() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => social.accounts.sync(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.accounts() });
    },
  });
}

// =============================================================================
// Campaigns
// =============================================================================

export function useSocialCampaigns() {
  const { social } = useAppApi();
  return useQuery({
    queryKey: socialKeys.campaigns(),
    queryFn: () => social.campaigns.list(),
  });
}

export function useCreateSocialCampaign() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => social.campaigns.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.campaigns() });
    },
  });
}

export function useUpdateSocialCampaign() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Record<string, unknown>) =>
      social.campaigns.update(id, data),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: socialKeys.campaign(id) });
      qc.invalidateQueries({ queryKey: socialKeys.campaigns() });
    },
  });
}

export function useDeleteSocialCampaign() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => social.campaigns.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.campaigns() });
    },
  });
}

// =============================================================================
// Media
// =============================================================================

export function useSocialMedia() {
  const { social } = useAppApi();
  return useQuery({
    queryKey: socialKeys.media(),
    queryFn: () => social.media.list(),
  });
}

export function useCreateSocialMedia() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => social.media.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.media() });
    },
  });
}

function useDeleteSocialMedia() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => social.media.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.media() });
    },
  });
}

// =============================================================================
// Approvals
// =============================================================================

export function useSocialApprovals(params?: Record<string, unknown>) {
  const { social } = useAppApi();
  return useQuery({
    queryKey: socialKeys.approvals(params),
    queryFn: () => social.approvals.list(params),
  });
}

export function useUpdateSocialApproval() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Record<string, unknown>) =>
      social.approvals.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.approvals() });
    },
  });
}

// =============================================================================
// Team
// =============================================================================

export function useSocialTeam() {
  const { social } = useAppApi();
  return useQuery({
    queryKey: socialKeys.team(),
    queryFn: () => social.team.list(),
  });
}

export function useCreateSocialTeamMember() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => social.team.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.team() });
    },
  });
}

export function useUpdateSocialTeamMember() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Record<string, unknown>) =>
      social.team.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.team() });
    },
  });
}

export function useDeleteSocialTeamMember() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => social.team.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.team() });
    },
  });
}

// =============================================================================
// Settings
// =============================================================================

export function useSocialSettings() {
  const { social } = useAppApi();
  return useQuery({
    queryKey: socialKeys.settings(),
    queryFn: () => social.settings.get(),
  });
}

export function useUpdateSocialSettings() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => social.settings.update(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.settings() });
    },
  });
}

export function useSocialTimezones() {
  const { social } = useAppApi();
  return useQuery({
    queryKey: socialKeys.timezones(),
    queryFn: () => social.settings.timezones(),
  });
}

// =============================================================================
// Analytics sync
// =============================================================================

export function useSyncSocialPostMetrics() {
  const { social } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (postId: string) => social.analytics.sync(postId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: socialKeys.posts() });
    },
  });
}
