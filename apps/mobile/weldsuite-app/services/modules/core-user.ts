/**
 * P1 `core-user` module — workspace/org/apps, user profile + addresses,
 * push-token registration, and the notifications/settings-notifications
 * surface of the legacy weldsuite-app `ApiService`, rebacked onto app-api.
 *
 * Every method preserves its legacy name, signature, and screen-facing
 * return shape (`ApiResponse<{ success, data }>` where that was the
 * contract) while calling app-api underneath. Composed into the facade in
 * services/api.ts by the assembler.
 *
 * Endpoint map (legacy mobile-api-worker /v1 → app-api /api):
 * - /v1/apps, /v1/apps/categories, /v1/apps/:code → /api/app-catalog[...]
 *   (app-api translates canonical codes to legacy codes server-side)
 * - /v1/workspace/apps (GET)                → /api/dashboard/installed-apps
 * - /v1/workspace/apps (POST/DELETE)        → /api/app-catalog/:code/install
 * - /v1/workspace/members                   → /api/team-members
 * - /v1/organizations, /api/mobile/v1/workspaces → /api/workspaces
 * - /v1/user/profile                        → /api/team-members/me (+ PATCH
 *                                             /api/team-members/user/:userId/profile)
 * - /v1/user/push-token                     → /api/push-tokens
 * - /v1/user/account (DELETE)               → POST /api/account/delete
 * - /v1/notifications/*, /v1/settings/notifications/* → /api/notifications/*
 * - /v1/settings/notification-preferences   → /api/notification-preferences (per-row)
 * - VoIP passthrough: /v1/crm/call-intelligence/* → /api/call-intelligence/* +
 *   /api/calls (token endpoint flips GET → POST)
 */

import type {
  ApiResponse,
  InstalledApp,
  Workspace,
  WorkspaceMember,
  WorkspaceWithMembership,
  NotificationPreferences,
  ModuleChannelPreferences,
} from '@weldsuite/mobile-ui/types';

import { appApiClient } from '../app-api';
import {
  toError,
  notSupported,
  buildQuery,
  cursorForPage,
  rememberCursor,
  type AppApiPagination,
} from './shared';

// ============================================================================
// Types owned by this module (previously non-exported interfaces inside the
// legacy services/api.ts; used in public signatures so they move here).
// ============================================================================

export interface Address {
  id?: string;
  firstName: string;
  lastName: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  isDefault?: boolean;
}

export interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  addresses?: Address[];
}

// ============================================================================
// Generic passthrough with legacy-path rewrite table.
//
// contexts/VoipContext.tsx calls api.get/post/put with LEGACY v1 paths
// (`/crm/call-intelligence/...`). The rewrite table maps them to the live
// app-api routes; the token endpoint additionally flips GET → POST because
// app-api issues Twilio tokens via POST /call-intelligence/token.
// ============================================================================

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function rewriteLegacyPath(method: HttpMethod, path: string): { method: HttpMethod; path: string } {
  const [pathname, query] = path.split('?');
  const q = query ? `?${query}` : '';
  if (pathname === '/crm/call-intelligence/token') {
    // Verb delta: legacy GET, app-api POST.
    return { method: 'POST', path: `/call-intelligence/token${q}` };
  }
  if (pathname === '/crm/call-intelligence/calls' || pathname.startsWith('/crm/call-intelligence/calls/')) {
    // Calls live on the flat /api/calls resource.
    return { method, path: pathname.replace('/crm/call-intelligence/calls', '/calls') + q };
  }
  if (pathname.startsWith('/crm/call-intelligence')) {
    return { method, path: pathname.replace('/crm/call-intelligence', '/call-intelligence') + q };
  }
  return { method, path };
}

async function rawRequest(method: HttpMethod, legacyPath: string, body?: unknown): Promise<ApiResponse<any>> {
  const rewritten = rewriteLegacyPath(method, legacyPath);
  try {
    let res: any;
    switch (rewritten.method) {
      case 'GET':
        res = await appApiClient.get<any>(rewritten.path);
        break;
      case 'POST':
        res = await appApiClient.post<any>(rewritten.path, body ?? {});
        break;
      case 'PUT':
        res = await appApiClient.put<any>(rewritten.path, body ?? {});
        break;
      case 'PATCH':
        res = await appApiClient.patch<any>(rewritten.path, body ?? {});
        break;
      case 'DELETE':
        res = await appApiClient.delete<any>(rewritten.path);
        break;
    }
    // app-api single envelope is { data }; 204 responses come back as {}.
    const data = res && typeof res === 'object' && 'data' in res ? res.data : res;
    return { success: true, data };
  } catch (err) {
    return toError(err);
  }
}

// ============================================================================
// Workspace / org / apps
// ============================================================================

/**
 * app-api's /dashboard/installed-apps returns CANONICAL weld* app codes
 * (raw `workspaceInstalledApps.appCode` — unlike /app-catalog, it does NOT
 * translate server-side). Every consumer in this app (APP_ROUTES in
 * app/_layout.tsx, APP_CONFIG in MiniSidebar/AppDrawer, the home grid) keys
 * on LEGACY codes, so translate here — same map the retired
 * mobile-api-worker /v1/workspace/apps route applied.
 */
const DB_TO_LEGACY: Record<string, string> = {
  welddesk: 'helpdesk',
  weldmail: 'mail',
  weldcrm: 'crm',
  weldstash: 'wms',
  weldbooks: 'accounting',
  weldflow: 'projects',
  weldconnect: 'task',
  weldhost: 'host',
};

async function getInstalledApps(): Promise<InstalledApp[]> {
  try {
    // Returns { data: string[] } of installed CANONICAL app codes — translate
    // to legacy codes and map to InstalledApp[] objects; the
    // InstalledAppsContext gates modules on `appCode`.
    const res = await appApiClient.get<{ data: string[] }>('/dashboard/installed-apps');
    return (res.data ?? []).map((code: string, i: number) => {
      const legacyCode = DB_TO_LEGACY[code] ?? code;
      return {
        id: legacyCode,
        workspaceId: '',
        appCode: legacyCode,
        name: legacyCode,
        status: 'active',
        displayOrder: i,
      };
    }) as InstalledApp[];
  } catch {
    return [];
  }
}

async function getWorkspaceMembers(search?: string): Promise<ApiResponse<WorkspaceMember[]>> {
  try {
    const res = await appApiClient.get<{ data: any[] }>(`/team-members${buildQuery({ search })}`);
    const members = (res.data ?? []).map((row: any) => ({
      id: row.id,
      userId: row.userId,
      workspaceId: row.workspaceId ?? '',
      name: row.name ?? row.email ?? '',
      email: row.email ?? undefined,
      picture: row.picture ?? undefined,
      role: row.role ?? 'member',
      status: row.status ?? undefined,
      joinedAt: row.joinedAt ?? row.createdAt ?? undefined,
    })) as WorkspaceMember[];
    return { success: true, data: members };
  } catch (err) {
    return toError(err);
  }
}

async function getOrganizations(): Promise<ApiResponse<any[]>> {
  try {
    const res = await appApiClient.get<{ data: any[] }>('/workspaces');
    return { success: true, data: res.data ?? [] };
  } catch (err) {
    return toError(err);
  }
}

async function switchOrganization(_organizationId: string): Promise<ApiResponse<{ redirectUrl: string }>> {
  // TODO(phase-out): no app-api switch route — org switching is Clerk
  // `setActive` on-device; WorkspaceContext already falls back to it.
  return notSupported('Switch workspaces via Clerk setActive on-device');
}

async function getCurrentWorkspace(): Promise<ApiResponse<Workspace>> {
  // app-api has no single "current workspace" endpoint; returning a failure
  // lets WorkspaceProvider fall back to the active Clerk org (the source of
  // truth for which workspace is current).
  return { success: false };
}

async function getUserWorkspaces(): Promise<ApiResponse<WorkspaceWithMembership[]>> {
  try {
    const res = await appApiClient.get<{ data: any[] }>('/workspaces');
    // WorkspaceProvider expects WorkspaceWithMembership[]. WorkspaceSummary.id
    // is the Clerk org id (what setActive/switchWorkspace expects).
    const mapped = (res.data ?? []).map((w: any) => ({
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

// ============================================================================
// User / profile / addresses / account
// ============================================================================

function splitName(name: string): { firstName?: string; lastName?: string } {
  const parts = name.split(' ').filter(Boolean);
  if (parts.length === 0) return {};
  return { firstName: parts[0], lastName: parts.length > 1 ? parts.slice(1).join(' ') : undefined };
}

async function getProfile(): Promise<ApiResponse<User>> {
  try {
    const res = await appApiClient.get<{ data: any }>('/team-members/me');
    const row = res.data ?? {};
    return {
      success: true,
      data: {
        id: row.userId ?? row.id ?? '',
        email: row.email ?? '',
        ...splitName(typeof row.name === 'string' ? row.name : ''),
      },
    };
  } catch (err) {
    return toError(err);
  }
}

async function updateProfile(profileData: Partial<User>): Promise<ApiResponse<User>> {
  try {
    const me = await appApiClient.get<{ data: any }>('/team-members/me');
    const userId: string | undefined = me.data?.userId;
    if (!userId) {
      return { success: false, error: { title: 'not_found', message: 'Current member not found' } };
    }
    // TODO(phase-out): app-api's member profile has no firstName/lastName/
    // email fields (those live in Clerk and should be edited on-device) —
    // only `phone` is forwarded to PATCH /team-members/user/:userId/profile.
    const patch: Record<string, unknown> = {};
    if (profileData.phone !== undefined) patch.phone = profileData.phone;
    const res = await appApiClient.patch<{ data: any }>(
      `/team-members/user/${encodeURIComponent(userId)}/profile`,
      patch,
    );
    const profile = res.data ?? {};
    return {
      success: true,
      data: {
        id: userId,
        email: me.data?.email ?? '',
        firstName: profileData.firstName ?? splitName(me.data?.name ?? '').firstName,
        lastName: profileData.lastName ?? splitName(me.data?.name ?? '').lastName,
        phone: profile.phone ?? profileData.phone,
      },
    };
  } catch (err) {
    return toError(err);
  }
}

async function requestPasswordReset(_email: string): Promise<ApiResponse<{ success: boolean }>> {
  // TODO(phase-out): password resets are Clerk on-device flows; the legacy
  // /v1/user/password-reset route was never mounted (dead in prod).
  return notSupported('Password reset is handled by Clerk on-device');
}

async function requestDataExport(): Promise<ApiResponse<{ success: boolean }>> {
  // TODO(phase-out): no app-api data-export endpoint; the legacy
  // /v1/user/data-export route was never mounted (dead in prod).
  return notSupported('Data export is not available from the mobile API');
}

async function deleteAccount(): Promise<ApiResponse<{ success: boolean }>> {
  try {
    // Org-less app-api account route (Google Play deletion requirement).
    // Requires the typed confirmation string; blocked with 409 when the user
    // is the sole admin of a workspace that still has other members.
    await appApiClient.post<{ data: any }>('/account/delete', { confirmation: 'DELETE' });
    return { success: true, data: { success: true } };
  } catch (err) {
    return toError(err);
  }
}

async function getAddresses(): Promise<ApiResponse<Address[]>> {
  // TODO(phase-out): mobile-only user addresses have no app-api home (the
  // legacy /user/profile/addresses path was never mounted — dead in prod).
  // Option flagged for the orchestrator: persist in /api/user-preferences.
  return notSupported('User addresses are not available on app-api');
}

async function addAddress(_address: Omit<Address, 'id'>): Promise<ApiResponse<Address>> {
  // TODO(phase-out): see getAddresses.
  return notSupported('User addresses are not available on app-api');
}

async function updateAddress(_id: string, _address: Partial<Address>): Promise<ApiResponse<Address>> {
  // TODO(phase-out): see getAddresses.
  return notSupported('User addresses are not available on app-api');
}

async function deleteAddress(_id: string): Promise<ApiResponse<void>> {
  // TODO(phase-out): see getAddresses.
  return notSupported('User addresses are not available on app-api');
}

// ============================================================================
// Push tokens (services/notifications.ts checks `.registered`/`.unregistered`)
// ============================================================================

async function registerDevice(deviceData: {
  deviceId: string;
  token: string;
  platform: string;
  tokenType?: string;
  deviceModel?: string;
  osVersion?: string;
  appVersion?: string;
}): Promise<ApiResponse<{ id: string; deviceId: string; platform: string; registered: boolean }>> {
  try {
    // POST /api/push-tokens returns { deviceId, platform, registered }
    // (`appCode` defaults to 'weldsuite', `tokenType` to 'expo' server-side).
    const res = await appApiClient.post<{
      data: { deviceId: string; platform: string; registered: boolean };
    }>('/push-tokens', deviceData);
    return {
      success: true,
      data: { id: res.data?.deviceId ?? deviceData.deviceId, ...res.data },
    };
  } catch (err) {
    return toError(err);
  }
}

async function unregisterDevice(deviceId: string): Promise<ApiResponse<{ deviceId: string; unregistered: boolean }>> {
  try {
    const res = await appApiClient.delete<{ data: { deviceId: string; unregistered: boolean } }>(
      `/push-tokens${buildQuery({ deviceId })}`,
    );
    return { success: true, data: res.data };
  } catch (err) {
    return toError(err);
  }
}

// ============================================================================
// Notification preferences (app/settings/notifications.tsx)
// ============================================================================

async function getNotificationPreferences(): Promise<ApiResponse<NotificationPreferences>> {
  try {
    // TODO(phase-out): app-api stores notification preferences PER-ROW
    // (GET /api/notification-preferences returns a row list) while the legacy
    // endpoint returned a single NotificationPreferences blob. The legacy
    // /settings/notification-preferences route was never mounted (dead in
    // prod), so returning the rows matches the welddesk-app precedent.
    const res = await appApiClient.get<{ data: any[] }>('/notification-preferences');
    return { success: true, data: (res.data ?? []) as unknown as NotificationPreferences };
  } catch (err) {
    return toError(err);
  }
}

async function updateNotificationPreferences(
  _preferences: Partial<NotificationPreferences>,
): Promise<ApiResponse<NotificationPreferences>> {
  // TODO(phase-out): app-api notification preferences are per-row
  // (PATCH /api/notification-preferences/:id) — the legacy blanket PUT has
  // no equivalent. Flagged for the orchestrator (per-row diffing option).
  return notSupported('Update notification preferences per row via app-api');
}

async function updateModuleNotificationPreferences(
  _module: string,
  _prefs: ModuleChannelPreferences,
): Promise<ApiResponse<NotificationPreferences>> {
  // TODO(phase-out): see updateNotificationPreferences.
  return notSupported('Update notification preferences per row via app-api');
}

async function updateGlobalNotificationSettings(_settings: {
  doNotDisturb?: boolean;
  soundEnabled?: boolean;
}): Promise<ApiResponse<NotificationPreferences>> {
  // TODO(phase-out): see updateNotificationPreferences.
  return notSupported('Update notification preferences per row via app-api');
}

async function sendTestNotification(): Promise<ApiResponse<{ success: boolean; message: string }>> {
  // TODO(phase-out): no app-api test-notification endpoint (the legacy
  // /notifications/test route was never mounted — dead in prod).
  return notSupported('Test notifications are not available on app-api');
}

// ============================================================================
// Notifications (bell + settings list)
// ============================================================================

async function getNotificationHistory(limit: number = 50): Promise<ApiResponse<{ notifications: any[] }>> {
  try {
    const res = await appApiClient.get<{ data: any[] }>(`/notifications${buildQuery({ limit })}`);
    return { success: true, data: { notifications: res.data ?? [] } };
  } catch (err) {
    return toError(err);
  }
}

async function getUnreadNotificationCount(): Promise<ApiResponse<{ count: number }>> {
  try {
    const res = await appApiClient.get<{ data: { count: number } }>('/notifications/unread-count');
    return { success: true, data: res.data };
  } catch (err) {
    return toError(err);
  }
}

async function markNotificationAsRead(
  notificationId: string,
): Promise<ApiResponse<{ success: boolean; message: string }>> {
  try {
    await appApiClient.post<{ data: any }>(`/notifications/${encodeURIComponent(notificationId)}/read`, {});
    return { success: true, data: { success: true, message: 'Notification marked as read' } };
  } catch (err) {
    return toError(err);
  }
}

async function listNotifications(page: number = 1, pageSize: number = 50): Promise<ApiResponse<any[]>> {
  try {
    // Cursor-map pagination: page 1 resets the stream, page N > 1 replays the
    // cursor remembered from the previous response (app-api has no `page`).
    const cursor = cursorForPage('notifications', page);
    const res = await appApiClient.get<{ data: any[]; pagination?: AppApiPagination }>(
      `/notifications${buildQuery({ limit: pageSize, cursor })}`,
    );
    rememberCursor('notifications', res.pagination ?? null);
    return { success: true, data: res.data ?? [] };
  } catch (err) {
    return toError(err);
  }
}

async function getSettingsUnreadCount(): Promise<ApiResponse<{ count: number }>> {
  return getUnreadNotificationCount();
}

async function markNotificationRead(notificationId: string): Promise<ApiResponse<any>> {
  try {
    const res = await appApiClient.post<{ data: any }>(
      `/notifications/${encodeURIComponent(notificationId)}/read`,
      {},
    );
    return { success: true, data: res.data };
  } catch (err) {
    return toError(err);
  }
}

async function markAllNotificationsRead(): Promise<ApiResponse<any>> {
  try {
    const res = await appApiClient.post<{ data: any }>('/notifications/read-all', {});
    return { success: true, data: res.data };
  } catch (err) {
    return toError(err);
  }
}

async function deleteNotification(notificationId: string): Promise<ApiResponse<any>> {
  try {
    // 204 No Content on success.
    await appApiClient.delete<unknown>(`/notifications/${encodeURIComponent(notificationId)}`);
    return { success: true };
  } catch (err) {
    return toError(err);
  }
}

async function getDevices(): Promise<ApiResponse<{ devices: any[] }>> {
  // TODO(phase-out): /api/push-tokens has no GET (list) — the legacy
  // /notifications/devices route was never mounted (dead in prod).
  // Consumer: app/settings/devices.tsx.
  return notSupported('Registered-device listing is not available on app-api');
}

// ============================================================================
// Module export — composed into the `api` facade by services/api.ts.
// ============================================================================

export const coreUserModule = {
  // ----- generic passthroughs (VoipContext legacy-path rewrite) -----
  // The legacy base ignored the 2nd options arg on get() (VoipContext.tsx:190
  // passes `{ params }`); this facade ignores it too.
  async get(path: string, _options?: unknown): Promise<ApiResponse<any>> {
    return rawRequest('GET', path);
  },
  async post(path: string, body?: unknown): Promise<ApiResponse<any>> {
    return rawRequest('POST', path, body);
  },
  async put(path: string, body?: unknown): Promise<ApiResponse<any>> {
    return rawRequest('PUT', path, body);
  },
  async patch(path: string, body?: unknown): Promise<ApiResponse<any>> {
    return rawRequest('PATCH', path, body);
  },
  async delete(path: string): Promise<ApiResponse<any>> {
    return rawRequest('DELETE', path);
  },

  // ----- apps object literal (app store screens) -----
  apps: {
    getAvailable: async (): Promise<any[]> => {
      try {
        // app-api translates canonical codes to legacy codes server-side.
        const res = await appApiClient.get<{ data: any[] }>('/app-catalog');
        return res.data ?? [];
      } catch {
        return [];
      }
    },

    getInstalled: async (): Promise<any[]> => {
      return getInstalledApps();
    },

    getCategories: async (): Promise<string[]> => {
      try {
        const res = await appApiClient.get<{ data: string[] }>('/app-catalog/categories');
        return res.data ?? [];
      } catch {
        return [];
      }
    },

    getByCode: async (code: string): Promise<any | null> => {
      try {
        const res = await appApiClient.get<{ data: any }>(`/app-catalog/${encodeURIComponent(code)}`);
        return res.data ?? null;
      } catch {
        return null;
      }
    },

    install: async (appCode: string, settings?: Record<string, any>): Promise<any> => {
      // POST /app-catalog/:code/install accepts legacy codes and an optional
      // { settings } body (installCatalogAppSchema). NOTE: unlike the legacy
      // /v1/workspace/apps route, app-api requires OWNER/ADMIN — member-role
      // users now get a 403 here.
      try {
        const res = await appApiClient.post<{ data: any }>(
          `/app-catalog/${encodeURIComponent(appCode)}/install`,
          settings !== undefined ? { settings } : {},
        );
        return res.data;
      } catch (err) {
        const adapted = toError(err);
        const message =
          typeof adapted.error === 'object' && adapted.error
            ? adapted.error.message
            : 'Failed to install app';
        throw new Error(message);
      }
    },

    uninstall: async (appCode: string): Promise<void> => {
      try {
        // 204 No Content on success. Accepts legacy codes.
        await appApiClient.delete<unknown>(`/app-catalog/${encodeURIComponent(appCode)}/install`);
      } catch (err) {
        const adapted = toError(err);
        const message =
          typeof adapted.error === 'object' && adapted.error
            ? adapted.error.message
            : 'Failed to uninstall app';
        throw new Error(message);
      }
    },
  },

  // ----- workspace / org -----
  getInstalledApps,
  getWorkspaceMembers,
  getOrganizations,
  switchOrganization,
  getCurrentWorkspace,
  getUserWorkspaces,

  // ----- user / profile / account -----
  getProfile,
  updateProfile,
  requestPasswordReset,
  requestDataExport,
  deleteAccount,
  getAddresses,
  addAddress,
  updateAddress,
  deleteAddress,

  // ----- push tokens -----
  registerDevice,
  unregisterDevice,

  // ----- notification preferences -----
  getNotificationPreferences,
  updateNotificationPreferences,
  updateModuleNotificationPreferences,
  updateGlobalNotificationSettings,
  sendTestNotification,

  // ----- notifications -----
  getNotificationHistory,
  getUnreadNotificationCount,
  markNotificationAsRead,
  listNotifications,
  getSettingsUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  getDevices,
};

export default coreUserModule;
