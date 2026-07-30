/**
 * Notification + notification-preference hooks.
 *
 * Fully on app-api. Preferences are a singleton-per-user record: the writes go
 * through `PUT /notification-preferences` (upsert — the row may not exist yet)
 * and `PUT /notification-preferences/module/:module` (server-side merge into
 * the `modulePreferences` JSONB), which mirror the legacy api-worker contract
 * these hooks used to call.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

/** app-api list envelope — `{ data, pagination }` with an opaque cursor. */
interface ListEnvelope<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

// =============================================================================
// Types
// =============================================================================

export interface NotificationPreferences {
  id?: string;
  userId?: string;
  workspaceId?: string;
  doNotDisturb: boolean;
  soundEnabled: boolean;
  modulePreferences: Record<string, ModuleChannelPreferences>;
  defaultInApp: boolean;
  defaultEmail: boolean;
  defaultPush: boolean;
  defaultDesktop: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ModuleChannelPreferences {
  enabled: boolean;
  inApp: boolean;
  email: boolean;
  push: boolean;
  desktop: boolean;
}
// =============================================================================
// Query Keys
// =============================================================================

export const notificationKeys = {
  all: ['notifications'] as const,
  list: (filters?: Record<string, unknown>) => [...notificationKeys.all, 'list', filters] as const,
  unreadCount: () => [...notificationKeys.all, 'unread-count'] as const,
  preferences: () => [...notificationKeys.all, 'preferences'] as const,
};/**
 * The user's notification preferences.
 *
 * app-api exposes this as a self-scoped list rather than a singleton, so we take
 * the first (and only — the table is unique on userId) row. The legacy route
 * synthesised a defaults object when no row existed yet; that fallback is
 * reproduced here so consumers never have to null-check.
 */
const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  doNotDisturb: false,
  soundEnabled: true,
  modulePreferences: {},
  defaultInApp: true,
  defaultEmail: false,
  defaultPush: true,
  defaultDesktop: true,
};

export function useNotificationPreferences() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: notificationKeys.preferences(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<ListEnvelope<NotificationPreferences>>(
        '/notification-preferences?limit=1',
      );
      return result.data?.[0] ?? DEFAULT_NOTIFICATION_PREFERENCES;
    },
  });
}

// =============================================================================
// Notification Mutations
// =============================================================================

/**
 * Upsert the caller's preferences.
 *
 * Send only the keys you are changing — the server merges them onto the
 * existing row and applies defaults for the rest on the user's first write, so
 * this works whether or not a preference row exists yet.
 */
export function useUpdateNotificationPreferences() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Partial<NotificationPreferences>) => {
      const client = await getClient();
      return client.put<{ data: NotificationPreferences }>('/notification-preferences', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notificationKeys.preferences() });
    },
  });
}

/**
 * Merge one module's channel prefs into the `modulePreferences` JSONB.
 * The merge is server-side, so toggling one module leaves the others untouched.
 */
export function useUpdateModulePreferences() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ module, prefs }: { module: string; prefs: ModuleChannelPreferences }) => {
      const client = await getClient();
      return client.put<{ data: NotificationPreferences }>(
        `/notification-preferences/module/${encodeURIComponent(module)}`,
        prefs,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notificationKeys.preferences() });
    },
  });
}

/**
 * DND / sound live on the same singleton row, so this is the same upsert
 * narrowed to the two global fields (the legacy `/global` endpoint was too).
 */
export function useUpdateGlobalNotificationSettings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (settings: { doNotDisturb?: boolean; soundEnabled?: boolean }) => {
      const client = await getClient();
      return client.put<{ data: NotificationPreferences }>('/notification-preferences', settings);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notificationKeys.preferences() });
    },
  });
}