/**
 * Workspace / team / app-store settings hooks.
 *
 * Everything here targets app-api. The obsolete api-worker client hook is
 * fully gone from this file as of W5b — every surface below is on app-api.
 *
 * Migrated to app-api (W5b, settings area):
 *   - /settings/workspace              → GET|PUT /api/workspace-settings
 *   - /settings/api-keys               → /api/api-keys (personal, self-scoped)
 *   - /settings/workspace-api-keys     → /api/workspace-api-keys
 *   - /settings/members/:id            → PATCH /api/team-members/:id
 *   - /settings/members/:id/permissions → GET /api/team-members/:id/permissions
 *   - /settings/members/:id/apps       → GET /api/team-members/:id/apps
 *   - /settings/members/:id/apps/toggle → POST /api/team-members/:id/apps/toggle
 *   - /settings/available-apps         → GET /api/app-catalog?codes=canonical
 *   - /settings/printnode              → GET|PUT /api/printnode
 *
 * Deleted rather than ported (dead code — grep-proven zero importers, and the
 * unexported ones are unreachable through hooks/queries/index.ts's `export *`):
 *   - useGenerateUploadUrl / useConfirmUpload / useGetFileUrl / useDeleteFile
 *     — pointed at /settings/storage/*, which NEVER existed in api-worker
 *       (404 today; the only real upload surface is app-api /api/storage's
 *       generate-upload-url + confirm-upload, which nothing here used).
 *   - useUpdateMemberApps — bulk app replace; no call site.
 *
 * NOTE on envelopes: app-api answers `{ data }` with no `success` flag, but
 * several consumers of these hooks (components/settings/api-keys-section.tsx,
 * components/team-member-details-panel.tsx) branch on `result.success`. Those
 * components are outside this task's file ownership, so the hooks below
 * synthesize `success: true` on the way out — the client throws on non-2xx, so
 * reaching the return statement IS the success signal.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { installedAppsKeys } from '@/hooks/use-installed-apps';
import { teamKeys } from '@/hooks/queries/use-team-queries';

// =============================================================================
// Query Keys
// =============================================================================

const settingsKeys = {
  all: ['settings'] as const,
  workspace: () => [...settingsKeys.all, 'workspace'] as const,
  members: (filters?: Record<string, any>) => [...settingsKeys.all, 'members', filters] as const,
  apiKeys: () => [...settingsKeys.all, 'api-keys'] as const,
  workspaceApiKeys: () => [...settingsKeys.all, 'workspace-api-keys'] as const,
  myApps: () => [...settingsKeys.all, 'my-apps'] as const,
  memberApps: (memberId: string) => [...settingsKeys.all, 'member-apps', memberId] as const,
  memberPermissions: (memberId: string) => [...settingsKeys.all, 'member-permissions', memberId] as const,
  integrations: () => [...settingsKeys.all, 'integrations'] as const,
  printNode: () => [...settingsKeys.all, 'printnode'] as const,
  customFields: (entityType?: string) =>
    (entityType
      ? [...settingsKeys.all, 'custom-fields', entityType]
      : [...settingsKeys.all, 'custom-fields']) as readonly unknown[],
  customFieldsAll: () => [...settingsKeys.all, 'custom-fields-all'] as const,
  customField: (id: string) => [...settingsKeys.all, 'custom-field', id] as const,
  telephonyPricing: () => [...settingsKeys.all, 'telephony-pricing'] as const,
  telephonyServiceRates: () => [...settingsKeys.all, 'telephony-service-rates'] as const,
  invitation: (token: string) => [...settingsKeys.all, 'invitation', token] as const,
  roles: () => [...settingsKeys.all, 'roles'] as const,
};

// =============================================================================
// Helper to build query string
// =============================================================================

function buildQueryString(params: Record<string, any>): string {
  const queryParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      queryParams.set(key, String(value));
    }
  }
  const query = queryParams.toString();
  return query ? `?${query}` : '';
}

// =============================================================================
// Queries
// =============================================================================

/**
 * The `workspace_settings` business blob (legal name, address, timezone, …) —
 * app-api `GET /api/workspace-settings` (was api-worker `GET
 * /settings/workspace`). Same singleton row, same `general:read` gate.
 *
 * `data` is `null` when the workspace has never saved its settings; callers
 * fall back to their own defaults.
 */
export function useWorkspaceSettings() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: settingsKeys.workspace(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any }>('/workspace-settings');
    },
  });
}

/**
 * Workspace member directory — app-api `GET /api/team-members`.
 *
 * The legacy /settings/members used offset paging (`page`/`pageSize`); app-api
 * is cursor-based, so `page` is accepted for signature compatibility and
 * ignored — every current caller reads page 1 only. `pageSize` maps to `limit`
 * (server caps it at 100). `memberType=all` preserves the legacy behaviour of
 * listing external guests alongside employees.
 *
 * Fields are visibility-projected server-side: admins see the full row, other
 * members see id/userId/name/picture/role/status/memberType (plus their own
 * email). The legacy route was `team:read`-gated, so non-admins previously got
 * a 403 and an empty list.
 */
export function useWorkspaceMembers(page?: number, pageSize?: number) {
  const filters = { page, pageSize };
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: settingsKeys.members(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString({
        limit: pageSize !== undefined ? Math.min(pageSize, 100) : undefined,
        memberType: 'all',
      });
      return client.get<{
        data: any[];
        pagination: {
          totalCount: number;
          hasMore: boolean;
          cursor: string | null;
        };
      }>(`/team-members${query}`);
    },
  });
}

/**
 * The caller's own personal API keys — app-api `GET /api/api-keys` (was
 * api-worker `GET /settings/api-keys`). Scoped to the JWT user server-side;
 * `keyHash` is never returned.
 */
function useApiKeys() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: settingsKeys.apiKeys(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any[] }>('/api-keys');
    },
  });
}

/**
 * Workspace-wide API keys — app-api `GET /api/workspace-api-keys` (was
 * api-worker `GET /settings/workspace-api-keys`).
 *
 * A different table from the personal `api_keys` above: these are shared
 * credentials any admin can see and revoke. `apikeys:read` gated.
 */
export function useWorkspaceApiKeys() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: settingsKeys.workspaceApiKeys(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any[] }>('/workspace-api-keys');
    },
  });
}

function useMyApps() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: settingsKeys.myApps(),
    queryFn: async () => {
      const client = await getClient();
      // app-api GET /api/appstore/my-apps (was /settings/my-apps).
      return client.get<{ data: string[] }>('/appstore/my-apps');
    },
  });
}

/**
 * List all roles in the workspace (system + custom). Used by the team-member
 * panel role select so admins can assign custom roles.
 *
 * app-api `GET /api/roles` (was api-worker `GET /settings/roles`).
 */
export function useWorkspaceRoles(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: settingsKeys.roles(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{
        data?: Array<{
          id: string;
          name: string;
          description?: string;
          isSystemRole: boolean;
          memberCount: number;
        }>;
      }>('/roles');
    },
    enabled,
  });
}

/**
 * Every app installed in the workspace, flagged with whether this member is
 * assigned to it — app-api `GET /api/team-members/:id/apps` (was api-worker
 * `GET /settings/members/:id/apps`). `team:read` gated, as before.
 *
 * Rows are `MemberAppAssignment` (appCode / appName / isAssigned / assignedAt /
 * assignedBy); `appName` is resolved server-side from the same APP_NAMES map
 * the role editor uses, so brand names (not capitalised codes) render here.
 */
export function useMemberApps(memberId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: settingsKeys.memberApps(memberId),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: any[] }>(`/team-members/${memberId}/apps`);
      return { success: true as const, data: result.data };
    },
    enabled: !!memberId && enabled,
  });
}

export interface MemberPermissionsData {
  effective: string[];
  rolePermissions: string[];
  memberOverrides: string[];
  role: string;
  roleId: string | null;
}

/**
 * A named member's permission breakdown — app-api
 * `GET /api/team-members/:id/permissions` (was api-worker
 * `GET /settings/members/:id/permissions`). `team:read` gated, as before.
 *
 * Distinct from /api/me/permissions, which is self-only and returns a resolved
 * effective set. This splits *stored* grants into role-derived vs per-member
 * override so the panel can render inherited rows checked-but-disabled. A bare
 * system tier (OWNER/ADMIN with no custom role) therefore reports empty arrays
 * — its wildcards are not stored on the row. That is the legacy behaviour the
 * panel is built around.
 */
export function useMemberPermissions(memberId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: settingsKeys.memberPermissions(memberId),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: MemberPermissionsData }>(
        `/team-members/${memberId}/permissions`,
      );
      return { success: true as const, data: result.data };
    },
    enabled: !!memberId && enabled,
  });
}

/**
 * Connected third-party integrations — app-api `GET /api/integrations` (was
 * api-worker `GET /settings/integrations`). Same `integrations` table; the
 * app-api route is cursor-paginated, so the rows arrive under `data` with a
 * `pagination` sibling instead of a bare `{ success, data }`.
 */
export function useIntegrations() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: settingsKeys.integrations(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{
        data: any[];
        pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
      }>('/integrations?limit=100');
    },
  });
}

/**
 * PrintNode integration config — app-api `GET /api/printnode` (ported from
 * api-worker `GET /settings/printnode`). `general:read` gated, so every member
 * tier can read it. `data` is null when PrintNode was never configured.
 *
 * The blob lives in `workspace_settings.customSettings.printnode`; it has no
 * table of its own.
 *
 * BUGFIX: the legacy unified client called `/api/settings/integrations/printnode`,
 * which api-worker never served (only `/api/settings/printnode` exists, and
 * `GET /integrations` does not match the sub-path) — so this screen has been
 * 404ing on both read and save. It now points at a route that exists.
 *
 * The consumer (settings/integrations/[id]/integration-detail-client.tsx) reads
 * `printNodeData.data.apiKey`, so the `{ data }` envelope is passed through
 * as-is rather than unwrapped.
 */
export function usePrintNodeSettings() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: settingsKeys.printNode(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any }>('/printnode');
    },
  });
}

// =============================================================================
// Mutations
// =============================================================================

/**
 * Upsert the workspace settings blob — app-api `PUT /api/workspace-settings`
 * (was api-worker `PUT /settings/workspace`). `general:update` gated.
 *
 * Server-side this also mirrors `timezone` into the master `digest_schedules`
 * row and pushes the business/address details onto the Stripe customer, both
 * best-effort. Callers only need to know it resolved.
 */
export function useUpdateWorkspaceSettings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Record<string, any>) => {
      const client = await getClient();
      return client.put<{ data: any }>('/workspace-settings', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.workspace() });
    },
  });
}

/**
 * Mint a personal API key — app-api `POST /api/api-keys`. The response carries
 * the plaintext `key` exactly once; it is unrecoverable afterwards.
 */
function useCreateApiKey() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name: string;
      description?: string;
      scopes?: string[];
      expiresAt?: string;
    }) => {
      const client = await getClient();
      const result = await client.post<{ data: any }>('/api-keys', data);
      return { success: true as const, data: result.data };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.apiKeys() });
    },
  });
}

/** Revoke a personal API key — app-api `DELETE /api/api-keys/:id` (204). */
function useRevokeApiKey() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete<void>(`/api-keys/${id}`);
      return { success: true as const };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.apiKeys() });
    },
  });
}

/**
 * Mint a workspace API key — app-api `POST /api/workspace-api-keys`. The
 * response carries the plaintext `key` exactly once; it is unrecoverable
 * afterwards, which is why api-keys-section.tsx shows it in a one-time dialog.
 */
export function useCreateWorkspaceApiKey() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name: string;
      description?: string;
      scopes?: string[];
    }) => {
      const client = await getClient();
      const result = await client.post<{ data: any }>('/workspace-api-keys', data);
      return { success: true as const, data: result.data };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.workspaceApiKeys() });
    },
  });
}

/** Revoke a workspace API key — app-api `DELETE /api/workspace-api-keys/:id` (204). */
export function useRevokeWorkspaceApiKey() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete<void>(`/workspace-api-keys/${id}`);
      return { success: true as const };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.workspaceApiKeys() });
    },
  });
}

/**
 * Rename / re-scope a workspace API key — app-api
 * `PUT /api/workspace-api-keys/:id`. Metadata only; the key material is
 * immutable (rotating means revoking and re-issuing).
 */
export function useUpdateWorkspaceApiKey() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: {
      id: string;
      data: { name?: string; description?: string; scopes?: string[] };
    }) => {
      const client = await getClient();
      const result = await client.put<{ data: any }>(`/workspace-api-keys/${id}`, data);
      return { success: true as const, data: result.data };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.workspaceApiKeys() });
    },
  });
}

/**
 * Update a member's name / permission overrides / contracted hours — app-api
 * `PATCH /api/team-members/:id` (was api-worker `PUT /settings/members/:id`).
 * `team:update` gated.
 *
 * Also accepts `role` / `roleId`, but prefer useUpdateMemberRole below for a
 * pure role change — same endpoint, and its name says what it does.
 */
export function useUpdateMember() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: {
      id: string;
      data: { name?: string; role?: string; roleId?: string; permissions?: string[]; hoursPerWeek?: string };
    }) => {
      const client = await getClient();
      const result = await client.patch<{ data: { id: string } }>(`/team-members/${id}`, data);
      return { success: true as const, data: result.data };
    },
    onSuccess: (_data, variables) => {
      // Both query trees cache members — see the note in useUpdateMemberRole.
      // A name / hours write shows up in the team panel (teamKeys) too, so
      // invalidate both or the panel renders stale values.
      qc.invalidateQueries({ queryKey: settingsKeys.members() });
      qc.invalidateQueries({ queryKey: settingsKeys.memberPermissions(variables.id) });
      qc.invalidateQueries({ queryKey: teamKeys.members() });
      qc.invalidateQueries({ queryKey: teamKeys.member(variables.id) });
    },
  });
}

export function useUpdateMemberRole() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: {
      id: string;
      data: { role?: string; roleId?: string };
    }) => {
      // app-api PATCH /team-members/:id. The endpoint hard-locks the workspace
      // OWNER (403) so a member can never be demoted out of ownership here, and
      // persists the custom-role id in `roleId` (system tier in `role`). It
      // returns `{ data: { id } }`; callers only care that it resolved.
      const client = await getClient();
      await client.patch<{ data: { id: string } }>(`/team-members/${id}`, data);
      return { success: true as const };
    },
    onSuccess: (_data, variables) => {
      // Both query trees cache members:
      //   - settingsKeys.members()  → useWorkspaceMembers() directory list
      //   - teamKeys.members()      → /team-members list + per-member fetches
      // Both now read app-api, but they are separate caches: invalidate both or
      // the visible panel + team list show stale data and the role appears to
      // revert.
      qc.invalidateQueries({ queryKey: settingsKeys.members() });
      qc.invalidateQueries({ queryKey: settingsKeys.memberPermissions(variables.id) });
      qc.invalidateQueries({ queryKey: teamKeys.members() });
      qc.invalidateQueries({ queryKey: teamKeys.member(variables.id) });
    },
  });
}

/**
 * Grant or revoke a single app for a member — app-api
 * `POST /api/team-members/:id/apps/toggle` (was api-worker
 * `POST /settings/members/:id/apps/toggle`). `team:update` gated, as before:
 * this edits another member's access, so it stays OWNER/ADMIN-only. The panel
 * already disables the control unless `canManageMembers`.
 *
 * The caller (team-member-details-panel.tsx) branches on `result.success`.
 */
export function useToggleMemberApp() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, appCode, enabled }: {
      id: string;
      appCode: string;
      enabled: boolean;
    }) => {
      const client = await getClient();
      await client.post<{ data: { appCode: string; enabled: boolean } }>(
        `/team-members/${id}/apps/toggle`,
        { appCode, enabled },
      );
      return { success: true as const };
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: settingsKeys.members() });
      qc.invalidateQueries({ queryKey: settingsKeys.memberApps(variables.id) });
      qc.invalidateQueries({ queryKey: installedAppsKeys.all });
    },
  });
}

/**
 * Save the PrintNode integration config — app-api `PUT /api/printnode` (was
 * api-worker `PUT /settings/printnode`). `general:update` gated: it is a
 * workspace-wide integration credential, not a self-scoped setting.
 *
 * Sends `{ apiKey: '' }` to disconnect. See usePrintNodeSettings for the 404
 * this repoint fixes.
 */
export function useUpdatePrintNodeSettings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { apiKey: string }) => {
      const client = await getClient();
      return client.put<{ data: any }>('/printnode', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.printNode() });
      qc.invalidateQueries({ queryKey: settingsKeys.integrations() });
    },
  });
}



// =============================================================================
// Custom Fields — Queries
// =============================================================================

export interface CustomFieldDefinition {
  id: string;
  entityType: string;
  name: string;
  slug: string;
  description?: string | null;
  fieldType: string;
  options?: { label: string; value: string; color?: string }[] | null;
  config?: Record<string, unknown> | null;
  required?: boolean;
  sortOrder?: number;
  group?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateCustomFieldData {
  entityType: string;
  name: string;
  slug: string;
  description?: string;
  fieldType: string;
  options?: { label: string; value: string; color?: string }[];
  config?: Record<string, unknown>;
  required?: boolean;
  sortOrder?: number;
  group?: string;
}

export interface UpdateCustomFieldData {
  name?: string;
  description?: string;
  fieldType?: string;
  options?: { label: string; value: string; color?: string }[];
  config?: Record<string, unknown>;
  required?: boolean;
  sortOrder?: number;
  group?: string;
}

// Custom fields are served by app-api at /api/custom-fields (was api-worker
// /settings/custom-fields) — same table, same sub-paths (/all, /reorder, /:id).

export function useCustomFields(entityType?: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: settingsKeys.customFields(entityType),
    queryFn: async () => {
      const client = await getClient();
      const query = entityType ? `?entityType=${entityType}` : '';
      const result = await client.get<{ data: CustomFieldDefinition[] }>(`/custom-fields${query}`);
      return result.data;
    },
  });
}

function useAllCustomFields() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: settingsKeys.customFieldsAll(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: Record<string, CustomFieldDefinition[]> }>('/custom-fields/all');
      return result.data;
    },
  });
}

function useCustomField(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: settingsKeys.customField(id),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: CustomFieldDefinition }>(`/custom-fields/${id}`);
      return result.data;
    },
    enabled: !!id && enabled,
  });
}

// =============================================================================
// Custom Fields — Mutations
// =============================================================================

export function useCreateCustomField() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateCustomFieldData) => {
      const client = await getClient();
      return client.post<{ data: CustomFieldDefinition }>('/custom-fields', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.customFields() });
      qc.invalidateQueries({ queryKey: settingsKeys.customFieldsAll() });
    },
  });
}

export function useUpdateCustomField() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateCustomFieldData }) => {
      const client = await getClient();
      return client.put<{ data: CustomFieldDefinition }>(`/custom-fields/${id}`, data);
    },
    onSuccess: (_d, variables) => {
      qc.invalidateQueries({ queryKey: settingsKeys.customFields() });
      qc.invalidateQueries({ queryKey: settingsKeys.customFieldsAll() });
      qc.invalidateQueries({ queryKey: settingsKeys.customField(variables.id) });
    },
  });
}

export function useDeleteCustomField() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      // app-api replies `{ data: { deleted: true } }` here rather than 204.
      return client.delete<{ data: { deleted: boolean } }>(`/custom-fields/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.customFields() });
      qc.invalidateQueries({ queryKey: settingsKeys.customFieldsAll() });
    },
  });
}

function useReorderCustomFields() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (items: { id: string; sortOrder: number }[]) => {
      const client = await getClient();
      return client.put<{ data: { reordered: number } }>('/custom-fields/reorder', { items });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.customFields() });
      qc.invalidateQueries({ queryKey: settingsKeys.customFieldsAll() });
    },
  });
}

// =============================================================================
// Telephony Pricing — Queries
// =============================================================================

interface TelephonyPricingEntry {
  countryCode: string;
  numberType: string;
  monthlyPrice: number;
  currency: string;
  stripePriceId?: string;
}

// app-api /api/telephony/* (was api-worker /settings/telephony/*). The legacy
// worker returned `pricing` / `rates` at the top level; app-api nests them
// inside the standard `{ data }` envelope.

function useTelephonyPricing() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: settingsKeys.telephonyPricing(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: { pricing: TelephonyPricingEntry[] } }>('/telephony/pricing');
      return result.data.pricing;
    },
  });
}

function useTelephonyServiceRates() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: settingsKeys.telephonyServiceRates(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{
        data: { rates: { voipCallMinute: number; callTranscriptionMinute: number } };
      }>('/telephony/service-rates');
      return result.data.rates;
    },
  });
}

// =============================================================================
// Invitations — Queries & Mutations
// =============================================================================

interface InvitationDetails {
  workspaceId: string;
  workspaceName: string;
  role: string;
  expiresAt?: string;
  isExpired: boolean;
  isUsed: boolean;
  inviteeEmail: string;
  inviteeName: string;
}

interface AcceptInvitationResult {
  workspaceId: string;
  workspaceName: string;
  role: string;
}

// app-api /api/invitations/* — same paths and payload fields the legacy
// unified client used, now under the standard `{ data }` envelope. Both hooks
// keep returning the bare payload so callers are unchanged.

export function useInvitationDetails(token: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: settingsKeys.invitation(token),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: InvitationDetails }>(
        `/invitations/${encodeURIComponent(token)}`,
      );
      return result.data;
    },
    enabled: !!token && enabled,
  });
}

export function useAcceptInvitation() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (token: string) => {
      const client = await getClient();
      const result = await client.post<{ data: AcceptInvitationResult }>('/invitations/accept', { token });
      return result.data;
    },
  });
}

// =============================================================================
// App Store
// =============================================================================

export interface AvailableApp {
  code: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  provider: string;
  verified: boolean;
  isInstalled: boolean;
  path?: string;
  overview?: string | null;
  features?: string[];
  howItWorks?: { title: string; description: string }[];
  version?: string;
  releasedAt?: string | null;
  websiteUrl?: string | null;
  documentationUrl?: string | null;
  contactUrl?: string | null;
  screenshots?: any[];
}

// The legacy /settings app-store surface is split across two app-api routes:
//   - /api/app-catalog  — browse + install/uninstall for the workspace
//   - /api/appstore     — the per-user / per-workspace side (my-apps,
//                         installed-apps, can-manage-apps, assign-all-members)

/**
 * The published app catalog with per-workspace install status — app-api
 * `GET /api/app-catalog` (was api-worker `GET /settings/available-apps`).
 *
 * Two things had to change server-side before this could be repointed, both
 * done in W5b:
 *
 *  1. The route now projects `verified` / `releasedAt` / `websiteUrl` /
 *     `documentationUrl` / `contactUrl`. app/appstore/[code] feeds this row
 *     straight into AppDetailClient, which renders the release date next to
 *     the version and the three resource links in the sidebar — they were
 *     silently blank without these.
 *  2. `?codes=canonical` is required. By default the route back-translates
 *     `welddesk`/`weldmail` → `helpdesk`/`mail` for weldsuite-app (mobile),
 *     which is live on it. The master catalog stores the canonical codes and
 *     that is what the legacy route returned and what this UI is keyed on:
 *     `/appstore/:code` links, the `a.code === code` detail lookup, and
 *     app-store-client's APP_CODE_OVERRIDES (which keys on `mail`) all read
 *     app.code. Without the param the App Store silently reroutes and
 *     recategorises those two apps.
 *
 * `screenshots` on AvailableApp stays optional-and-absent: the legacy route
 * never projected it either (the rows live in a separate master table,
 * `app_screenshots`, that no catalog read joins), and nothing renders it.
 */
export function useAvailableApps() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...settingsKeys.all, 'available-apps'] as const,
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: AvailableApp[] }>('/app-catalog?codes=canonical');
      return result.data || [];
    },
  });
}

export function useAppCategories() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...settingsKeys.all, 'app-categories'] as const,
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: string[] }>('/app-catalog/categories');
      return result.data || [];
    },
  });
}

export function useCanManageApps() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...settingsKeys.all, 'can-manage-apps'] as const,
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: { canManage: boolean } }>('/appstore/can-manage-apps');
      return result.data?.canManage ?? false;
    },
  });
}

function useInstalledApps() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...settingsKeys.all, 'installed-apps'] as const,
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: any[] }>('/appstore/installed-apps');
      return result.data || [];
    },
  });
}

/**
 * Install an app for the workspace.
 *
 * The legacy worker took `assignToAllMembers` as a flag on the install body;
 * app-api splits that into two calls — install via /api/app-catalog, then the
 * bulk grant via /api/appstore. The grant only runs once the install succeeds,
 * matching the legacy ordering.
 */
export function useInstallApp() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ appCode, assignToAllMembers = false }: { appCode: string; assignToAllMembers?: boolean }) => {
      const client = await getClient();
      const result = await client.post<{ data: any }>(`/app-catalog/${appCode}/install`, {});
      if (assignToAllMembers) {
        await client.post<{ data: { appCode: string; assignedCount: number } }>(
          `/appstore/apps/${appCode}/assign-all-members`,
          {},
        );
      }
      return result;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...settingsKeys.all, 'available-apps'] });
      qc.invalidateQueries({ queryKey: [...settingsKeys.all, 'installed-apps'] });
      qc.invalidateQueries({ queryKey: installedAppsKeys.all });
    },
  });
}

export function useUninstallApp() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (appCode: string) => {
      const client = await getClient();
      // app-api answers 204 here (legacy replied `{ success: true }`).
      return client.delete<void>(`/app-catalog/${appCode}/install`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...settingsKeys.all, 'available-apps'] });
      qc.invalidateQueries({ queryKey: [...settingsKeys.all, 'installed-apps'] });
      qc.invalidateQueries({ queryKey: installedAppsKeys.all });
    },
  });
}

// =============================================================================
// User Preferences
// =============================================================================

export interface DayHours {
  isOpen: boolean;
  openTime?: string;
  closeTime?: string;
  breaks?: { start: string; end: string }[];
}

export interface WorkingHours {
  monday?: DayHours;
  tuesday?: DayHours;
  wednesday?: DayHours;
  thursday?: DayHours;
  friday?: DayHours;
  saturday?: DayHours;
  sunday?: DayHours;
}

export interface UserPreferences {
  theme: 'system' | 'light' | 'dark';
  fontSize: number;
  language: string;
  dateFormat: string;
  timeFormat: string;
  timezone: string;
  notifications?: {
    email?: boolean;
    push?: boolean;
    desktop?: boolean;
    sound?: boolean;
  };
  uiPreferences?: {
    sidebarCollapsed?: boolean;
    compactMode?: boolean;
    showWelcome?: boolean;
    defaultView?: string;
    sidebarAppOrder?: string[];
    onboardingCompleted?: boolean;
    onboardingCompletedAt?: string;
    primaryRole?: string;
    /** WeldMail: account to open by default (accountId or 'unified'). null = no preference. */
    mailDefaultAccountId?: string | null;
    /** WeldMail: last account/view the user opened (accountId or 'unified'). Fallback landing. */
    mailLastAccountId?: string | null;
    homeWidgets?: {
      slots: [
        { widgetId: string; settings: Record<string, unknown> } | null,
        { widgetId: string; settings: Record<string, unknown> } | null,
      ];
    };
  };
  workingHours?: WorkingHours | null;
}

interface TeamMemberWorkingHours {
  id: string;
  userId: string;
  name: string | null;
  email: string | null;
  picture: string | null;
  workingHours: WorkingHours | null;
}

// ---------------------------------------------------------------------------
// User preferences — backed by `app-api` at /api/user-preferences. The legacy
// /settings/preferences routes in api-worker still exist for back-compat with
// other clients, but the platform now talks to app-api exclusively.
// ---------------------------------------------------------------------------

export function useUserPreferences() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...settingsKeys.all, 'preferences'] as const,
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: UserPreferences }>('/user-preferences');
      return result.data;
    },
  });
}

export function useUpdateUserPreferences() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (preferences: Partial<UserPreferences>) => {
      const client = await getClient();
      return client.put<{ data: UserPreferences }>('/user-preferences', preferences);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...settingsKeys.all, 'preferences'] });
    },
  });
}

export function useUpdateTheme() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (theme: 'system' | 'light' | 'dark') => {
      const client = await getClient();
      return client.patch<{ data: { theme: string } }>('/user-preferences/theme', { theme });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...settingsKeys.all, 'preferences'] });
    },
  });
}

export function useUpdateFontSize() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (fontSize: number) => {
      const client = await getClient();
      return client.patch<{ data: { fontSize: number } }>('/user-preferences/font-size', { fontSize });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...settingsKeys.all, 'preferences'] });
    },
  });
}

function useUpdateSidebarAppOrder() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (appOrder: string[]) => {
      const client = await getClient();
      return client.put<{ data: UserPreferences }>('/user-preferences', {
        uiPreferences: { sidebarAppOrder: appOrder },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...settingsKeys.all, 'preferences'] });
    },
  });
}

const preferencesKey = [...settingsKeys.all, 'preferences'] as const;

// Optimistically patch the cached uiPreferences so mail landing prefs feel
// instant; rolls back on error and re-syncs from the server on settle.
function useMailUiPreferenceMutation(key: 'mailDefaultAccountId' | 'mailLastAccountId') {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (accountId: string | null) => {
      const client = await getClient();
      return client.put<{ data: UserPreferences }>('/user-preferences', {
        uiPreferences: { [key]: accountId },
      });
    },
    onMutate: async (accountId) => {
      await qc.cancelQueries({ queryKey: preferencesKey });
      const previous = qc.getQueryData<UserPreferences>(preferencesKey);
      if (previous) {
        qc.setQueryData<UserPreferences>(preferencesKey, {
          ...previous,
          uiPreferences: { ...previous.uiPreferences, [key]: accountId },
        });
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(preferencesKey, ctx.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: preferencesKey });
    },
  });
}

/** Pin (or clear, with `null`) the WeldMail account to open by default. */
export function useUpdateMailDefaultAccount() {
  return useMailUiPreferenceMutation('mailDefaultAccountId');
}

/** Record the last WeldMail account/view the user opened (landing fallback). */
export function useUpdateMailLastAccount() {
  return useMailUiPreferenceMutation('mailLastAccountId');
}

// =============================================================================
// Grid Views
// =============================================================================

// app-api /api/grid-views/:gridName (was api-worker /settings/grid-views/:gridName).

export function useGridViewSettings(gridName: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...settingsKeys.all, 'grid-view', gridName] as const,
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{
        data: { columnVisibility: Record<string, boolean>; columnWidths: Record<string, number> } | null;
      }>(`/grid-views/${gridName}`);
      return result.data;
    },
    enabled: !!gridName && enabled,
  });
}

export function useUpdateGridView() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      gridName: string;
      data: { columnVisibility: Record<string, boolean>; columnWidths: Record<string, number> };
    }) => {
      const client = await getClient();
      return client.put<{ data: any }>(`/grid-views/${params.gridName}`, params.data);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: [...settingsKeys.all, 'grid-view', variables.gridName] });
    },
  });
}

// =============================================================================
// Storage — intentionally absent.
//
// This file used to carry useGenerateUploadUrl / useConfirmUpload /
// useGetFileUrl / useDeleteFile, all pointed at /settings/storage/*. That
// prefix never existed in api-worker (its only upload surface is
// /crm/calls/upload-url), so every one of them 404'd. All four were also
// unexported with zero references repo-wide — unreachable even through
// hooks/queries/index.ts's `export *`. Deleted in W5b rather than ported.
//
// The real upload path is app-api /api/storage (generate-upload-url +
// confirm-upload), which callers invoke directly through useAppApiClient()
// rather than through a hook here — see app/settings/general/
// business-settings-form.tsx, app/weldchat/components/message-input.tsx and
// welddesk's conversation-detail-client.tsx.
// =============================================================================

// =============================================================================
// Working Hours
// =============================================================================

// app-api /api/working-hours (was api-worker /settings/working-hours,
// /settings/team/working-hours and /settings/members/:id/working-hours).

export function useWorkingHours() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...settingsKeys.all, 'working-hours'] as const,
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: { workingHours: WorkingHours | null } }>('/working-hours');
      return result.data.workingHours;
    },
  });
}

export function useUpdateWorkingHours() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (workingHours: WorkingHours) => {
      const client = await getClient();
      return client.put<{ data: { workingHours: WorkingHours } }>('/working-hours', { workingHours });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...settingsKeys.all, 'working-hours'] });
      qc.invalidateQueries({ queryKey: [...settingsKeys.all, 'preferences'] });
    },
  });
}

function useTeamWorkingHours() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...settingsKeys.all, 'team-working-hours'] as const,
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: TeamMemberWorkingHours[] }>('/working-hours/team');
      return result.data;
    },
  });
}

export function useMemberWorkingHours(memberId: string | null | undefined) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...settingsKeys.all, 'member-working-hours', memberId] as const,
    enabled: !!memberId,
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: { workingHours: WorkingHours | null } }>(
        `/working-hours/members/${memberId}`,
      );
      return result.data.workingHours;
    },
  });
}

export function useUpdateMemberWorkingHours() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ memberId, workingHours }: { memberId: string; workingHours: WorkingHours }) => {
      const client = await getClient();
      return client.put<{ data: { memberId: string; workingHours: WorkingHours } }>(
        `/working-hours/members/${memberId}`,
        { workingHours },
      );
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: [...settingsKeys.all, 'team-working-hours'] });
      qc.invalidateQueries({ queryKey: [...settingsKeys.all, 'member-working-hours', variables.memberId] });
    },
  });
}
