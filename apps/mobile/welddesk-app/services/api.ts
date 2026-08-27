/**
 * WeldDesk mobile API — desk conversations via app-api `/api/desk/*`.
 *
 * Matches the platform agent inbox surface (use-desk-queries).
 */

import { isApiError } from '@weldsuite/api-client/client';
import type { ApiResponse, Workspace, WorkspaceWithMembership, InstalledApp } from '@weldsuite/mobile-ui/types';

import { appApi, appApiClient, setAppApiTokenGetter, APP_API_URL } from './app-api';
import type {
  DeskConversation,
  DeskConversationFilters,
  DeskConversationSort,
  DeskConversationWithMessages,
  DeskListPagination,
  DeskMessage,
} from '@/types/desk';

export const API_URL = APP_API_URL;

let staticToken: string | null = null;
let refreshCallback: (() => Promise<string | null>) | null = null;

setAppApiTokenGetter(async () => {
  if (refreshCallback) {
    const token = await refreshCallback();
    if (token) return token;
  }
  return staticToken;
});

function toError(err: unknown): ApiResponse<never> {
  if (isApiError(err)) {
    return { success: false, error: { title: `api_error_${err.status}`, message: err.message } };
  }
  return {
    success: false,
    error: { title: 'network_error', message: err instanceof Error ? err.message : 'Request failed' },
  };
}

function buildConversationQuery(
  filters: DeskConversationFilters,
  sort?: DeskConversationSort,
  cursor?: string,
): string {
  const params = new URLSearchParams();
  if (filters.state) params.set('state', filters.state);
  if (filters.assigneeId) params.set('assigneeId', filters.assigneeId);
  if (filters.unassigned) params.set('unassigned', 'true');
  if (filters.channel) params.set('channel', filters.channel);
  if (sort) params.set('sort', sort);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

class WeldDeskApi {
  setTokenRefreshCallback(cb: (() => Promise<string | null>) | null) {
    refreshCallback = cb;
  }

  setAccessToken(token: string | null) {
    staticToken = token;
  }

  setOrganizationId(_orgId: string | null) {
    // No-op: app-api derives the workspace from the Clerk JWT's active org.
  }

  async getCurrentWorkspace(): Promise<ApiResponse<Workspace>> {
    return { success: false };
  }

  async getUserWorkspaces(): Promise<ApiResponse<WorkspaceWithMembership[]>> {
    try {
      const { data: workspaces } = await appApi.workspaces.list();
      const mapped = (workspaces ?? []).map((w) => ({
        id: w.id,
        clerkOrgId: w.id,
        name: w.name,
        slug: w.slug,
        imageUrl: w.imageUrl ?? undefined,
        isActive: true,
        role: w.role,
        membershipStatus: 'active',
      })) as unknown as WorkspaceWithMembership[];
      return { success: true, data: mapped };
    } catch (err) {
      return toError(err);
    }
  }

  async getInstalledApps(): Promise<InstalledApp[]> {
    try {
      const { data: codes } = await appApi.dashboard.installedApps();
      return (codes ?? []).map((code, i) => ({
        id: code,
        workspaceId: '',
        appCode: code,
        name: code,
        status: 'active',
        displayOrder: i,
      })) as unknown as InstalledApp[];
    } catch {
      return [];
    }
  }

  // ========== Desk conversations (platform parity) ==========

  async listConversations(
    filters: DeskConversationFilters = {},
    sort: DeskConversationSort = 'newest',
    cursor?: string,
  ): Promise<ApiResponse<{ items: DeskConversation[]; pagination: DeskListPagination }>> {
    try {
      const query = buildConversationQuery(filters, sort, cursor);
      const res = await appApiClient.get<{ data: DeskConversation[]; pagination: DeskListPagination }>(
        `/desk/conversations${query}`,
      );
      return {
        success: true,
        data: {
          items: res.data ?? [],
          pagination: res.pagination ?? { totalCount: 0, hasMore: false, cursor: null },
        },
      };
    } catch (err) {
      return toError(err);
    }
  }

  async getConversation(
    id: string,
    includeMessages = true,
  ): Promise<ApiResponse<DeskConversationWithMessages>> {
    try {
      const qs = includeMessages ? '?include=messages' : '';
      const res = await appApiClient.get<{ data: DeskConversationWithMessages }>(
        `/desk/conversations/${id}${qs}`,
      );
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async replyToConversation(
    id: string,
    data: { kind: 'message' | 'note'; body: string },
  ): Promise<ApiResponse<{ conversation: DeskConversation; message: DeskMessage }>> {
    try {
      const res = await appApiClient.post<{
        data: { conversation: DeskConversation; message: DeskMessage };
      }>(`/desk/conversations/${id}/reply`, data);
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async manageConversation(
    id: string,
    data:
      | { action: 'close' }
      | { action: 'open' }
      | { action: 'assign'; assigneeId?: string | null },
  ): Promise<ApiResponse<{ conversation: DeskConversation; message: DeskMessage }>> {
    try {
      const res = await appApiClient.post<{
        data: { conversation: DeskConversation; message: DeskMessage };
      }>(`/desk/conversations/${id}/manage`, data);
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  // ========== User / push ==========

  async registerDevice(deviceInfo: Record<string, unknown>): Promise<ApiResponse<unknown>> {
    try {
      const res = await appApi.pushTokens.register(deviceInfo as never);
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async unregisterDevice(deviceId: string): Promise<ApiResponse<unknown>> {
    try {
      const res = await appApi.pushTokens.unregister(deviceId);
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async getUnreadNotificationCount(): Promise<ApiResponse<{ count: number }>> {
    try {
      const res = await appApi.notifications.unreadCount();
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  // ========== Onboarding ==========

  async getOnboardingStatus(): Promise<ApiResponse<{ completed: boolean; hasOrganization: boolean }>> {
    try {
      const res = await appApiClient.get<{ data: { completed: boolean; hasOrganization: boolean } }>(
        '/onboarding/status',
      );
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async getOnboardingDatabaseStatus(): Promise<
    ApiResponse<{ provisioned: boolean; migrated: boolean }>
  > {
    try {
      const res = await appApiClient.get<{ data: { provisioned: boolean; migrated: boolean } }>(
        '/onboarding/database-status',
      );
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async saveProfile(data: {
    firstName: string;
    lastName: string;
    phone?: string;
    jobTitle?: string;
  }): Promise<ApiResponse<{ success: boolean }>> {
    try {
      const res = await appApiClient.post<{ data: { success: boolean } }>('/onboarding/profile', data);
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async createWorkspace(data: {
    name: string;
    country: string;
    referralSource?: string;
  }): Promise<ApiResponse<{ success: boolean; organizationId?: string; workspaceId?: string }>> {
    try {
      const res = await appApiClient.post<{
        data: { success: boolean; organizationId?: string; workspaceId?: string };
      }>('/onboarding/workspace', data);
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async saveRole(data: { role: string }): Promise<ApiResponse<{ success: boolean }>> {
    try {
      const res = await appApiClient.post<{ data: { success: boolean } }>('/onboarding/role', data);
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async completeOnboarding(
    data: Record<string, unknown>,
  ): Promise<ApiResponse<{ success: boolean; clerkOrgId?: string; workspaceId?: string }>> {
    try {
      const res = await appApiClient.post<{
        data: { success: boolean; clerkOrgId?: string; workspaceId?: string };
      }>('/onboarding/complete', data);
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async finalizeOnboarding(): Promise<ApiResponse<{ success: boolean }>> {
    try {
      const res = await appApiClient.post<{ data: { success: boolean } }>('/onboarding/finalize', {});
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }
}

const api = new WeldDeskApi();
export default api;
