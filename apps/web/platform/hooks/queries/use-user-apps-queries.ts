
import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { installedAppsKeys } from '@/hooks/use-installed-apps';

/**
 * WeldApps — user-created apps.
 *
 * Talks to the `app-api` `/user-apps` routes (built in parallel by the
 * backend-app-api specialist). Mirrors the query-hook conventions used
 * elsewhere in `hooks/queries/*` (see use-settings-queries.ts / use-weldagent-queries.ts):
 * plain `useAppApiClient().getClient()` + typed `{ data }` envelopes, with
 * mutations invalidating the relevant query keys on success.
 */

// =============================================================================
// Types
// =============================================================================

export type UserAppVisibility = 'private' | 'public';
export type UserAppReviewStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
export type UserAppPricingType = 'free' | 'subscription';

export interface UserApp {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  category?: string | null;
  visibility: UserAppVisibility;
  reviewStatus: UserAppReviewStatus;
  reviewNotes?: string | null;
  currentVersionId?: string | null;
  manifest?: Record<string, unknown> | null;
  requestedScopes: string[];
  pricingType: UserAppPricingType;
  priceMonthly?: number | null;
  currency?: string | null;
  installCount: number;
  isActive: boolean;
  createdAt: string;
}

/** A user app as returned by the installable store listing. */
export interface StoreUserApp extends UserApp {
  installed: boolean;
  /** Present when an already-installed app's manifest requests new scopes the member hasn't approved yet. */
  pendingScopes?: string[];
}

/** A user app as it appears in the sidenav / iframe host's installed list. */
export interface InstalledUserApp {
  appCode: string;
  userAppId: string;
  grantedScopes: string[];
  name: string;
  icon?: string | null;
  manifest?: Record<string, unknown> | null;
}

export interface UserAppVersion {
  version: string;
  status: string;
  changelog?: string | null;
  bundleSize?: number | null;
  fileCount?: number | null;
  createdAt: string;
  publishedAt?: string | null;
}

export interface CreateUserAppInput {
  code: string;
  name: string;
  description?: string;
  icon?: string;
  category?: string;
}

export interface UserAppOauthClient {
  clientId: string;
}

export interface UserAppOauthClientCreated {
  clientId: string;
  clientSecret: string;
}

/**
 * Thrown by `useInstallUserApp` when the app requires a paid subscription
 * (`402 { error: { code: 'SUBSCRIPTION_REQUIRED' } }`). The shared ClientApi
 * error handler only preserves `error.message`, not `code`/`details`, so this
 * one mutation talks to the worker directly instead of going through
 * `useAppApiClient()` — see the comment on `useInstallUserApp` below.
 */
export class SubscriptionRequiredError extends Error {
  readonly code = 'SUBSCRIPTION_REQUIRED' as const;
  readonly details: { priceMonthly: number; currency: string };

  constructor(details: { priceMonthly: number; currency: string }) {
    super('Subscription required to install this app.');
    this.name = 'SubscriptionRequiredError';
    this.details = details;
  }
}

// =============================================================================
// Query Keys
// =============================================================================

export const userAppsKeys = {
  all: ['user-apps'] as const,
  mine: () => [...userAppsKeys.all, 'mine'] as const,
  store: () => [...userAppsKeys.all, 'store'] as const,
  storeDetail: (code: string) => [...userAppsKeys.all, 'store', code] as const,
  // Scoped by org — same reasoning as installedAppsKeys.byOrg: without this,
  // switching workspaces could momentarily render the previous workspace's
  // installed apps from cache.
  installedByOrg: (orgId: string | null | undefined) =>
    [...userAppsKeys.all, 'installed', orgId ?? 'none'] as const,
  detail: (id: string) => [...userAppsKeys.all, 'detail', id] as const,
  versions: (id: string) => [...userAppsKeys.all, id, 'versions'] as const,
  oauthClient: (id: string) => [...userAppsKeys.all, id, 'oauth-client'] as const,
};

// =============================================================================
// Queries
// =============================================================================

/** My workspace's created apps ("My apps" developer UI). */
export function useMyUserApps() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: userAppsKeys.mine(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: UserApp[] }>('/user-apps');
      return result.data;
    },
  });
}

/** Installable apps for the App Store's "Custom apps" section. */
export function useUserAppStore() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: userAppsKeys.store(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: StoreUserApp[] }>('/user-apps/store');
      return result.data;
    },
  });
}

export function useUserAppStoreDetail(code: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: userAppsKeys.storeDetail(code),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: StoreUserApp }>(`/user-apps/store/${code}`);
      return result.data;
    },
    enabled: !!code && enabled,
  });
}

/** Installed user apps for the sidenav + iframe host. */
export function useInstalledUserApps() {
  const { getClient } = useAppApiClient();
  const { orgId } = useAuth();
  return useQuery({
    queryKey: userAppsKeys.installedByOrg(orgId),
    enabled: !!orgId,
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: InstalledUserApp[] }>('/user-apps/installed');
      return result.data;
    },
  });
}

export function useUserApp(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: userAppsKeys.detail(id),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: UserApp }>(`/user-apps/${id}`);
      return result.data;
    },
    enabled: !!id && enabled,
  });
}

export function useUserAppVersions(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: userAppsKeys.versions(id),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: UserAppVersion[] }>(`/user-apps/${id}/versions`);
      return result.data;
    },
    enabled: !!id && enabled,
  });
}

/**
 * The OAuth client id for an app, or `null` if none has been created yet.
 * Not explicitly requested by name in the spec, but needed by the "My apps"
 * OAuth section to know whether to show "Create" vs "Rotate".
 */
export function useUserAppOauthClient(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: userAppsKeys.oauthClient(id),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: UserAppOauthClient | null }>(`/user-apps/${id}/oauth-client`);
      return result.data;
    },
    enabled: !!id && enabled,
  });
}

// =============================================================================
// Mutations
// =============================================================================

export function useCreateUserApp() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateUserAppInput) => {
      const client = await getClient();
      const result = await client.post<{ data: UserApp }>('/user-apps', data);
      return result.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: userAppsKeys.mine() });
    },
  });
}

export function useUpdateUserApp() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<CreateUserAppInput> }) => {
      const client = await getClient();
      const result = await client.patch<{ data: UserApp }>(`/user-apps/${id}`, data);
      return result.data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: userAppsKeys.detail(variables.id) });
      qc.invalidateQueries({ queryKey: userAppsKeys.mine() });
    },
  });
}

export function useDeleteUserApp() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete<void>(`/user-apps/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: userAppsKeys.mine() });
    },
  });
}

/**
 * Upload a new bundle version. Callers build the FormData: a `manifest`
 * field (JSON string), an optional `changelog` field, and one `files` entry
 * per bundle file (named by its bundle-relative path).
 */
export function useUploadUserAppVersion() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, formData }: { id: string; formData: FormData }) => {
      const client = await getClient();
      const result = await client.postForm<{ data: UserAppVersion }>(`/user-apps/${id}/versions`, formData);
      return result.data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: userAppsKeys.versions(variables.id) });
      qc.invalidateQueries({ queryKey: userAppsKeys.detail(variables.id) });
      qc.invalidateQueries({ queryKey: userAppsKeys.mine() });
    },
  });
}

export function useSubmitUserApp() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, notes }: { id: string; notes?: string }) => {
      const client = await getClient();
      const result = await client.post<{ data: UserApp }>(`/user-apps/${id}/submit`, { notes });
      return result.data;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: userAppsKeys.detail(variables.id) });
      qc.invalidateQueries({ queryKey: userAppsKeys.mine() });
    },
  });
}

/**
 * Install an app. Bypasses `useAppApiClient()` and talks to the worker
 * directly with `fetch` — the shared ClientApi's `handleResponse` throws a
 * plain `Error` built from `error.message` only, discarding `error.code` and
 * `error.details`. Those are exactly what's needed to detect the 402
 * SUBSCRIPTION_REQUIRED case and show the right toast, so this mutation
 * reads the raw Response itself instead.
 */
export function useInstallUserApp() {
  const { getToken } = useAuth();
  const qc = useQueryClient();
  const apiBaseUrl = (import.meta.env.VITE_APP_API_URL as string | undefined) || 'http://localhost:8789';

  return useMutation({
    mutationFn: async ({ id, grantedScopes }: { id: string; grantedScopes: string[] }) => {
      const token = await getToken();
      if (!token) throw new Error('Authentication required');

      const response = await fetch(`${apiBaseUrl}/api/user-apps/${id}/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ grantedScopes }),
      });

      const json = await response.json().catch(() => ({}) as Record<string, unknown>);

      if (response.status === 402) {
        const err = (json as { error?: { code?: string; details?: { priceMonthly: number; currency: string } } }).error;
        if (err?.code === 'SUBSCRIPTION_REQUIRED') {
          throw new SubscriptionRequiredError(err.details ?? { priceMonthly: 0, currency: 'USD' });
        }
      }

      if (!response.ok) {
        const err = (json as { error?: { message?: string } }).error;
        throw new Error(err?.message || 'Failed to install app');
      }

      return (json as { data: { install: unknown; token: string } }).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: userAppsKeys.store() });
      qc.invalidateQueries({ queryKey: userAppsKeys.all });
      qc.invalidateQueries({ queryKey: installedAppsKeys.all });
    },
  });
}

export function useUninstallUserApp() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete<void>(`/user-apps/${id}/install`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: userAppsKeys.store() });
      qc.invalidateQueries({ queryKey: userAppsKeys.all });
      qc.invalidateQueries({ queryKey: installedAppsKeys.all });
    },
  });
}

export function useConsentUserAppScopes() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, approvedScopes }: { id: string; approvedScopes: string[] }) => {
      const client = await getClient();
      const result = await client.post<{ data: unknown }>(`/user-apps/${id}/consent`, { approvedScopes });
      return result.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: userAppsKeys.store() });
      qc.invalidateQueries({ queryKey: userAppsKeys.all });
      qc.invalidateQueries({ queryKey: installedAppsKeys.all });
    },
  });
}

export function useCreateUserAppOauthClient() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      const result = await client.post<{ data: UserAppOauthClientCreated }>(`/user-apps/${id}/oauth-client`);
      return result.data;
    },
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: userAppsKeys.oauthClient(id) });
    },
  });
}

/**
 * Mint a short-lived session token for the app's public bundle. Exposed as a
 * mutation (not a query) since the iframe host calls it imperatively — on
 * `weldapp:ready` and again whenever the sandboxed app asks for a fresh token.
 */
export function useUserAppSessionToken() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (code: string) => {
      const client = await getClient();
      const result = await client.post<{
        data: { token: string; expiresAt: string; apiBaseUrl: string };
      }>(`/user-apps/code/${code}/session-token`);
      return result.data;
    },
  });
}

/** Stable empty array reference so consumers can default without re-rendering. */
const EMPTY_INSTALLED_USER_APPS: InstalledUserApp[] = [];

/** Convenience: look up one installed user app by code from the installed list. */
export function useInstalledUserApp(appCode: string | undefined) {
  const { data } = useInstalledUserApps();
  return useMemo(
    () => (data ?? EMPTY_INSTALLED_USER_APPS).find((a) => a.appCode === appCode),
    [data, appCode],
  );
}
