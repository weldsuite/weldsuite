/**
 * App-API WeldSocial domain client.
 *
 * One cohesive surface over the `/api/social-*` route groups: accounts, posts
 * (with PostPeer publish/schedule actions), campaigns, media, analytics,
 * approvals, team members, and settings. Consumed by the platform SPA and the
 * mobile apps. Supersedes the legacy `apps/web/platform/lib/api/domains/social.ts`.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';

export type SocialPlatform = 'facebook' | 'instagram' | 'twitter' | 'linkedin' | 'tiktok';

export type SocialPostStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'cancelled';

export interface SocialPlatformContent {
  platform: SocialPlatform;
  accountId: string;
  content?: string;
  platformPostId?: string;
  publishedUrl?: string;
  status?: 'pending' | 'published' | 'failed';
  error?: string;
  publishedAt?: string;
}

export interface SocialAccount {
  id: string;
  platform: SocialPlatform;
  platformAccountId: string;
  name: string;
  username?: string | null;
  avatarUrl?: string | null;
  status: 'active' | 'inactive' | 'expired' | 'error' | 'pending_reauth';
  postpeerIntegrationId?: string | null;
  postpeerProfileId?: string | null;
  followerCount?: number | null;
  isDefault?: boolean | null;
  lastSyncAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SocialPost {
  id: string;
  title?: string | null;
  content: string;
  postType: 'post' | 'story' | 'reel' | 'thread' | 'carousel' | 'poll';
  status: SocialPostStatus;
  targetAccountIds: string[];
  platformContent?: SocialPlatformContent[] | null;
  mediaIds?: string[] | null;
  scheduledAt?: string | null;
  publishedAt?: string | null;
  timezone?: string | null;
  campaignId?: string | null;
  postpeerPostId?: string | null;
  labels?: string[] | null;
  tags?: string[] | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SocialCampaign {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
  status: 'draft' | 'active' | 'paused' | 'completed' | 'archived';
  startDate?: string | null;
  endDate?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SocialMedia {
  id: string;
  fileName: string;
  mediaType: 'image' | 'video' | 'gif';
  url?: string | null;
  thumbnailUrl?: string | null;
  status: string;
  altText?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SocialApproval {
  id: string;
  postId: string;
  status: 'pending' | 'approved' | 'rejected' | 'revision_requested' | 'withdrawn' | 'expired';
  submittedByUserId?: string | null;
  decisionNotes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SocialTeamMember {
  id: string;
  userId: string;
  email?: string | null;
  name?: string | null;
  role: 'owner' | 'admin' | 'manager' | 'editor' | 'contributor' | 'viewer';
  isActive?: boolean | null;
  createdAt: string;
  updatedAt: string;
}

export interface SocialDashboardStats {
  totalPosts: number;
  scheduledPosts: number;
  publishedThisWeek: number;
  pendingApproval: number;
  totalEngagement: number;
  connectedAccounts: number;
}

export interface SocialAnalyticsOverview {
  totalImpressions: number;
  totalReach: number;
  totalEngagement: number;
  totalClicks: number;
  engagementRate: number;
  topPosts: unknown[];
  platformStats: Array<{ platform: string; followers: number; posts: number; engagement: number }>;
}

export interface SocialSettings {
  defaultTimezone: string;
  defaultApprovalRequired: boolean;
  autoScheduleEnabled: boolean;
  hashtagSuggestions: boolean;
  linkShortening: boolean;
  [key: string]: unknown;
}

export interface PublishResult {
  postId: string;
  postpeerPostId: string;
  status: 'published' | 'scheduled' | 'failed';
  platformContent: SocialPlatformContent[];
}

type Q = Record<string, unknown>;

export function createSocialApi(api: ClientApi) {
  return {
    // --- Accounts ---------------------------------------------------------
    accounts: {
      list(params: Q = {}): Promise<ListResponse<SocialAccount>> {
        return api.get<ListResponse<SocialAccount>>(`/social-accounts${buildQueryString(params)}`);
      },
      get(id: string): Promise<DataResponse<SocialAccount>> {
        return api.get<DataResponse<SocialAccount>>(`/social-accounts/${id}`);
      },
      remove(id: string): Promise<void> {
        return api.delete<void>(`/social-accounts/${id}`);
      },
      /** Start the PostPeer hosted OAuth flow; returns a URL to open. */
      connect(platform: SocialPlatform, redirectUri?: string): Promise<DataResponse<{ url: string; profileId: string }>> {
        return api.post<DataResponse<{ url: string; profileId: string }>>('/social-accounts/connect', {
          platform,
          redirectUri,
        });
      },
      /** Import PostPeer-connected channels into socialAccounts. */
      sync(): Promise<DataResponse<{ synced: number; accountIds: string[] }>> {
        return api.post<DataResponse<{ synced: number; accountIds: string[] }>>('/social-accounts/sync', {});
      },
    },

    // --- Posts ------------------------------------------------------------
    posts: {
      list(params: Q = {}): Promise<ListResponse<SocialPost>> {
        return api.get<ListResponse<SocialPost>>(`/social-posts${buildQueryString(params)}`);
      },
      get(id: string): Promise<DataResponse<SocialPost>> {
        return api.get<DataResponse<SocialPost>>(`/social-posts/${id}`);
      },
      create(data: Partial<SocialPost> & Q): Promise<DataResponse<{ id: string }>> {
        return api.post<DataResponse<{ id: string }>>('/social-posts', data);
      },
      update(id: string, data: Partial<SocialPost> & Q): Promise<DataResponse<{ id: string }>> {
        return api.patch<DataResponse<{ id: string }>>(`/social-posts/${id}`, data);
      },
      remove(id: string): Promise<void> {
        return api.delete<void>(`/social-posts/${id}`);
      },
      /** Publish immediately via PostPeer. */
      publish(id: string): Promise<DataResponse<PublishResult>> {
        return api.post<DataResponse<PublishResult>>(`/social-posts/${id}/publish`, {});
      },
      /** Schedule for a future time via PostPeer. */
      schedule(id: string, scheduledAt: string, timezone?: string): Promise<DataResponse<PublishResult>> {
        return api.post<DataResponse<PublishResult>>(`/social-posts/${id}/schedule`, { scheduledAt, timezone });
      },
      reschedule(id: string, scheduledAt: string, timezone?: string): Promise<DataResponse<PublishResult>> {
        return api.post<DataResponse<PublishResult>>(`/social-posts/${id}/reschedule`, { scheduledAt, timezone });
      },
      cancel(id: string): Promise<DataResponse<{ id: string; status: string }>> {
        return api.post<DataResponse<{ id: string; status: string }>>(`/social-posts/${id}/cancel`, {});
      },
    },

    // --- Campaigns --------------------------------------------------------
    campaigns: {
      list(params: Q = {}): Promise<ListResponse<SocialCampaign>> {
        return api.get<ListResponse<SocialCampaign>>(`/social-campaigns${buildQueryString(params)}`);
      },
      get(id: string): Promise<DataResponse<SocialCampaign>> {
        return api.get<DataResponse<SocialCampaign>>(`/social-campaigns/${id}`);
      },
      create(data: Partial<SocialCampaign> & Q): Promise<DataResponse<{ id: string }>> {
        return api.post<DataResponse<{ id: string }>>('/social-campaigns', data);
      },
      update(id: string, data: Partial<SocialCampaign> & Q): Promise<DataResponse<{ id: string }>> {
        return api.patch<DataResponse<{ id: string }>>(`/social-campaigns/${id}`, data);
      },
      remove(id: string): Promise<void> {
        return api.delete<void>(`/social-campaigns/${id}`);
      },
    },

    // --- Media ------------------------------------------------------------
    media: {
      list(params: Q = {}): Promise<ListResponse<SocialMedia>> {
        return api.get<ListResponse<SocialMedia>>(`/social-media${buildQueryString(params)}`);
      },
      get(id: string): Promise<DataResponse<SocialMedia>> {
        return api.get<DataResponse<SocialMedia>>(`/social-media/${id}`);
      },
      create(data: Partial<SocialMedia> & Q): Promise<DataResponse<{ id: string }>> {
        return api.post<DataResponse<{ id: string }>>('/social-media', data);
      },
      update(id: string, data: Partial<SocialMedia> & Q): Promise<DataResponse<{ id: string }>> {
        return api.patch<DataResponse<{ id: string }>>(`/social-media/${id}`, data);
      },
      remove(id: string): Promise<void> {
        return api.delete<void>(`/social-media/${id}`);
      },
    },

    // --- Approvals --------------------------------------------------------
    approvals: {
      list(params: Q = {}): Promise<ListResponse<SocialApproval>> {
        return api.get<ListResponse<SocialApproval>>(`/social-approvals${buildQueryString(params)}`);
      },
      get(id: string): Promise<DataResponse<SocialApproval>> {
        return api.get<DataResponse<SocialApproval>>(`/social-approvals/${id}`);
      },
      create(data: Partial<SocialApproval> & Q): Promise<DataResponse<{ id: string }>> {
        return api.post<DataResponse<{ id: string }>>('/social-approvals', data);
      },
      update(id: string, data: Partial<SocialApproval> & Q): Promise<DataResponse<{ id: string }>> {
        return api.patch<DataResponse<{ id: string }>>(`/social-approvals/${id}`, data);
      },
      remove(id: string): Promise<void> {
        return api.delete<void>(`/social-approvals/${id}`);
      },
    },

    // --- Team -------------------------------------------------------------
    team: {
      list(params: Q = {}): Promise<ListResponse<SocialTeamMember>> {
        return api.get<ListResponse<SocialTeamMember>>(`/social-team-members${buildQueryString(params)}`);
      },
      get(id: string): Promise<DataResponse<SocialTeamMember>> {
        return api.get<DataResponse<SocialTeamMember>>(`/social-team-members/${id}`);
      },
      create(data: Partial<SocialTeamMember> & Q): Promise<DataResponse<{ id: string }>> {
        return api.post<DataResponse<{ id: string }>>('/social-team-members', data);
      },
      update(id: string, data: Partial<SocialTeamMember> & Q): Promise<DataResponse<{ id: string }>> {
        return api.patch<DataResponse<{ id: string }>>(`/social-team-members/${id}`, data);
      },
      remove(id: string): Promise<void> {
        return api.delete<void>(`/social-team-members/${id}`);
      },
    },

    // --- Analytics --------------------------------------------------------
    analytics: {
      overview(): Promise<DataResponse<SocialAnalyticsOverview>> {
        return api.get<DataResponse<SocialAnalyticsOverview>>('/social-analytics/overview');
      },
      stats(): Promise<DataResponse<SocialDashboardStats>> {
        return api.get<DataResponse<SocialDashboardStats>>('/social-analytics/stats');
      },
      search(q: string): Promise<DataResponse<Array<{ type: string; id: string; title: string; url: string }>>> {
        return api.get(`/social-analytics/search${buildQueryString({ q })}`);
      },
      sync(postId: string): Promise<DataResponse<{ snapshots: number }>> {
        return api.post<DataResponse<{ snapshots: number }>>(`/social-analytics/${postId}/sync`, {});
      },
    },

    // --- Settings ---------------------------------------------------------
    settings: {
      get(): Promise<DataResponse<SocialSettings>> {
        return api.get<DataResponse<SocialSettings>>('/social-settings');
      },
      update(data: Partial<SocialSettings>): Promise<DataResponse<{ message: string }>> {
        return api.put<DataResponse<{ message: string }>>('/social-settings', data);
      },
      timezones(): Promise<DataResponse<string[]>> {
        return api.get<DataResponse<string[]>>('/social-settings/timezones');
      },
    },
  };
}
