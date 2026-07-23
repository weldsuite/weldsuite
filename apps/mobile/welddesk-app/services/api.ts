/**
 * Legacy-compatible WeldDesk API facade, now backed by the unified app-api.
 *
 * The public surface (method names, `ApiResponse<T>` return shape, the
 * `setTokenRefreshCallback` / `setAccessToken` / `setOrganizationId` wiring
 * used by `app/_layout.tsx` and `app/setup.tsx`) is unchanged so screens
 * don't need rewrites. Internally every call now goes to app-api
 * (`services/app-api.ts`), and the app-api `{ data }` / `{ data, pagination }`
 * envelopes are adapted back to the legacy `{ success, data }` shape.
 *
 * Endpoint map (legacy mobile-api-worker /v2 → app-api /api):
 * - /v2/welddesk/conversations*        → /api/conversations (list/get/PATCH)
 * - /v2/welddesk/conversations/:id/messages
 *                                      → /api/helpdesk-weldagent/conversations/:id (read)
 *                                        + POST …/:id/messages (reply; same
 *                                        helpdesk_conversation_messages table)
 * - /v2/welddesk/tickets*              → /api/tickets
 * - /v2/welddesk/contacts*             → /api/helpdesk-contacts
 * - /v2/welddesk/dashboard             → /api/helpdesk-stats
 * - /v2/welddesk/teams                 → /api/desk/teams
 * - /v2/onboarding/*                   → /api/onboarding/*
 * - /v2/user/push-token                → /api/push-tokens
 * - /v2/user/notifications/unread-count → /api/notifications/unread-count
 * - /v2/user/organizations             → /api/workspaces
 * - /v2/workspace/apps                 → /api/dashboard/installed-apps
 */

import { isApiError } from '@weldsuite/api-client/client';
import type { ApiResponse, Workspace, WorkspaceWithMembership, InstalledApp } from '@weldsuite/mobile-ui/types';

import appApi, { appApiClient, setAppApiTokenGetter, APP_API_URL } from './app-api';

export const API_URL = APP_API_URL;

/** Static token fallback used when no refresh callback is wired. */
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

function buildQuery(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  }
  const query = searchParams.toString();
  return query ? `?${query}` : '';
}

class WeldDeskApi {
  // ========== Auth wiring (legacy-compatible) ==========
  setTokenRefreshCallback(cb: (() => Promise<string | null>) | null) {
    refreshCallback = cb;
  }

  setAccessToken(token: string | null) {
    staticToken = token;
  }

  setOrganizationId(_orgId: string | null) {
    // No-op: app-api derives the workspace from the Clerk JWT's active org.
  }

  // ========== Workspace ==========
  async getCurrentWorkspace(): Promise<ApiResponse<Workspace>> {
    // app-api has no single "current workspace" endpoint; returning a failure
    // lets WorkspaceProvider fall back to the active Clerk org (the source of
    // truth for which workspace is current).
    return { success: false };
  }

  async getUserWorkspaces(): Promise<ApiResponse<WorkspaceWithMembership[]>> {
    try {
      const { data: workspaces } = await appApi.workspaces.list();
      // WorkspaceProvider expects WorkspaceWithMembership[]. WorkspaceSummary.id
      // is the Clerk org id (what setActive/switchWorkspace expects).
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
      // Returns { data: string[] } of installed app codes — map to InstalledApp[].
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

  // ========== Helpdesk Conversations ==========
  async getConversations(params?: Record<string, unknown>): Promise<ApiResponse<any>> {
    try {
      const { contactId, ...rest } = params ?? {};
      const res = await appApiClient.get<{ data: any[] }>(`/conversations${buildQuery(rest)}`);
      let items = res.data ?? [];
      // app-api's list has no contactId filter — filter client-side (the
      // legacy /v2 route silently ignored the param altogether).
      if (contactId) items = items.filter((conv) => conv.contactId === contactId);
      return { success: true, data: items };
    } catch (err) {
      return toError(err);
    }
  }

  async getConversation(id: string): Promise<ApiResponse<any>> {
    try {
      const res = await appApiClient.get<{ data: any }>(`/conversations/${id}`);
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async getConversationMessages(id: string, _params?: { page?: number; limit?: number }): Promise<ApiResponse<any>> {
    try {
      // /api/helpdesk-weldagent/conversations/:id returns the conversation
      // plus its full helpdesk_conversation_messages history — the only
      // app-api surface for v1 conversation messages today.
      const res = await appApiClient.get<{ data: { messages?: any[] } }>(
        `/helpdesk-weldagent/conversations/${id}`,
      );
      return { success: true, data: res.data?.messages ?? [] };
    } catch (err) {
      return toError(err);
    }
  }

  async replyToConversation(id: string, body: { content: string; htmlContent?: string }): Promise<ApiResponse<any>> {
    try {
      // TODO(phase-out): posts through the weldagent message endpoint, which
      // stores authorName as "WeldAgent" instead of the replying agent's name
      // (authorId is still the real user). Swap to a dedicated agent-reply
      // route once the v1 helpdesk conversation surface is ported to app-api.
      const res = await appApiClient.post<{ data: any }>(
        `/helpdesk-weldagent/conversations/${id}/messages`,
        { content: body.content, role: 'assistant' },
      );
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async markConversationAsRead(id: string): Promise<ApiResponse<any>> {
    try {
      const res = await appApiClient.patch<{ data: any }>(`/conversations/${id}`, { isRead: true, unreadCount: 0 });
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async updateConversationStatus(id: string, status: string): Promise<ApiResponse<any>> {
    try {
      const res = await appApiClient.patch<{ data: any }>(`/conversations/${id}`, { status });
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async updateConversationPriority(id: string, priority: string): Promise<ApiResponse<any>> {
    try {
      const res = await appApiClient.patch<{ data: any }>(`/conversations/${id}`, { priority });
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async assignConversation(id: string, agentId: string): Promise<ApiResponse<any>> {
    try {
      const res = await appApiClient.patch<{ data: any }>(`/conversations/${id}`, { assigneeId: agentId });
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  // ========== Helpdesk Tickets ==========
  async getTickets(params?: { status?: string; page?: number; limit?: number }): Promise<ApiResponse<any>> {
    try {
      // app-api uses cursor pagination; the legacy page param is dropped.
      const res = await appApi.tickets.list({ status: params?.status, limit: params?.limit });
      return { success: true, data: res.data ?? [] };
    } catch (err) {
      return toError(err);
    }
  }

  async getTicket(id: string): Promise<ApiResponse<any>> {
    try {
      const res = await appApi.tickets.get(id);
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async createTicket(data: any): Promise<ApiResponse<any>> {
    try {
      // app-api's createTicketSchema requires customerName + customerEmail and
      // uses the low/medium/high/urgent/critical priority enum — adapt the
      // looser mobile payload (which may omit both and sends 'normal').
      const customerEmail: string = data.customerEmail || data.contactEmail || 'unknown@customer.weldsuite.org';
      const customerName: string =
        data.customerName || data.contactName || customerEmail.split('@')[0] || 'Unknown';
      const priority = data.priority === 'normal' ? 'medium' : data.priority;
      const res = await appApiClient.post<{ data: { id: string } }>('/tickets', {
        ...data,
        customerEmail,
        customerName,
        ...(priority ? { priority } : {}),
      });
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  // ========== Helpdesk Contacts ==========
  async getContacts(params?: { search?: string; page?: number; limit?: number }): Promise<ApiResponse<any>> {
    try {
      const res = await appApiClient.get<{ data: any[] }>(
        `/helpdesk-contacts${buildQuery({ search: params?.search, limit: params?.limit })}`,
      );
      // The contacts screen renders item.name — expose fullName under it too.
      const items = (res.data ?? []).map((row) => ({
        ...row,
        name: row.fullName || [row.firstName, row.lastName].filter(Boolean).join(' ') || undefined,
      }));
      return { success: true, data: items };
    } catch (err) {
      return toError(err);
    }
  }

  async getContact(id: string): Promise<ApiResponse<any>> {
    try {
      const res = await appApiClient.get<{ data: any }>(`/helpdesk-contacts/${id}`);
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  // ========== Helpdesk Dashboard ==========
  async getHelpdeskDashboard(): Promise<ApiResponse<any>> {
    try {
      // Aggregate ticket counts. Field names differ from the legacy
      // { tickets, conversations, recentTickets } shape (no screen consumes
      // this today).
      const res = await appApiClient.get<{ data: any }>('/helpdesk-stats');
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async getHelpdeskTeams(): Promise<ApiResponse<any>> {
    try {
      // v2 desk teams — the legacy helpdesk_teams table has no app-api surface.
      const res = await appApiClient.get<{ data: any[] }>('/desk/teams');
      return { success: true, data: res.data ?? [] };
    } catch (err) {
      return toError(err);
    }
  }

  // ========== User ==========
  async getUserProfile(): Promise<ApiResponse<any>> {
    // TODO(phase-out): no app-api profile endpoint — profile data comes from
    // Clerk on-device (useUser / useClerkAuth). No screen calls this.
    return { success: false, error: { title: 'not_supported', message: 'Use the Clerk user object instead' } };
  }

  async registerDevice(deviceInfo: any): Promise<ApiResponse<any>> {
    try {
      const res = await appApi.pushTokens.register(deviceInfo);
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async unregisterDevice(deviceId: string): Promise<ApiResponse<any>> {
    try {
      const res = await appApi.pushTokens.unregister(deviceId);
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async getNotificationPreferences(_emailAccountId?: string): Promise<ApiResponse<any>> {
    try {
      const res = await appApiClient.get<{ data: any[] }>('/notification-preferences');
      return { success: true, data: res.data ?? [] };
    } catch (err) {
      return toError(err);
    }
  }

  async updateNotificationPreferences(_preferences: any): Promise<ApiResponse<any>> {
    // TODO(phase-out): app-api notification-preferences are per-row
    // (PATCH /api/notification-preferences/:id) — the legacy blanket PATCH
    // has no equivalent. No screen calls this.
    return { success: false, error: { title: 'not_supported', message: 'Update preferences per row via app-api' } };
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
      const res = await appApiClient.get<{ data: { completed: boolean; hasOrganization: boolean } }>('/onboarding/status');
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async getOnboardingDatabaseStatus(): Promise<ApiResponse<{ provisioned: boolean; migrated: boolean }>> {
    try {
      const res = await appApiClient.get<{ data: { provisioned: boolean; migrated: boolean } }>('/onboarding/database-status');
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async saveProfile(data: { firstName: string; lastName: string; phone?: string; jobTitle?: string }): Promise<ApiResponse<{ success: boolean }>> {
    try {
      const res = await appApiClient.post<{ data: { success: boolean } }>('/onboarding/profile', data);
      return { success: true, data: res.data };
    } catch (err) {
      return toError(err);
    }
  }

  async createWorkspace(data: { name: string; country: string; referralSource?: string }): Promise<ApiResponse<{ success: boolean; organizationId?: string; workspaceId?: string }>> {
    try {
      const res = await appApiClient.post<{ data: { success: boolean; organizationId?: string; workspaceId?: string } }>('/onboarding/workspace', data);
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

  async completeOnboarding(data: Record<string, unknown>): Promise<ApiResponse<{ success: boolean; clerkOrgId?: string; workspaceId?: string }>> {
    try {
      const res = await appApiClient.post<{ data: { success: boolean; clerkOrgId?: string; workspaceId?: string } }>('/onboarding/complete', data);
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
