/**
 * WeldCommerce online store: the hosted shop of a storefront channel, built in
 * WeldSuite (`builder`) or uploaded by the merchant (`static`). Served by the
 * Rust `commerce` module (EU edition); the contract is
 * `weldsuite-documentation/plans/weldcommerce-storefronts.md`.
 *
 * - Sites:       GET / POST /online-store/sites, GET / PATCH / DELETE /:id
 * - Draft:       PUT /:id/draft `{ document, revision }`; 409
 *                `REVISION_CONFLICT` (`details.currentRevision`) when someone
 *                else saved first, 400 `VALIDATION_ERROR` (`details.fields`)
 * - Publishing:  POST /:id/publish, GET /:id/versions,
 *                POST /:id/versions/:versionId/restore and /copy-to-draft
 * - Preview:     POST /:id/preview → `{ url, expiresAt }`
 * - Content:     /:id/pages, /:id/menus/:handle, /:id/redirects
 * - Deployments: /:id/deployments (multipart upload), /:depId/promote
 * - Hosts:       /storefront-hosts/config, /storefront-hosts?siteId=,
 *                POST /storefront-hosts, /:id/refresh, /:id/primary, DELETE /:id
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MenuItem, Section, SiteDocument, ShopLocale } from '@weldsuite/storefront-theme/catalog';
import type { DataResponse } from '@weldsuite/core-api-client/types';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { commerceKeys } from '@/hooks/queries/use-commerce-queries';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SiteMode = 'builder' | 'static';
export type SiteVisibility = 'live' | 'password' | 'coming_soon';

export interface OnlineStoreSite {
  id: string;
  channelId: string;
  channelName: string;
  channelStatus: string;
  mode: SiteMode;
  locale: ShopLocale;
  theme: string;
  visibility: SiteVisibility;
  hasPassword: boolean;
  draftRevision: number;
  draftUpdatedAt: string;
  publishedVersionId: string | null;
  publishedVersionNumber: number | null;
  publishedAt: string | null;
  hasUnpublishedChanges: boolean;
  activeDeploymentId: string | null;
  primaryHost: string | null;
  previewHost: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A site as `GET /sites/:id` answers it: with its draft document. */
export interface OnlineStoreSiteDetail extends OnlineStoreSite {
  draft: SiteDocument;
}

export interface CreateSiteInput {
  channelId: string;
  mode?: SiteMode;
  locale?: ShopLocale;
}

export interface UpdateSiteInput {
  locale?: ShopLocale;
  mode?: SiteMode;
  visibility?: SiteVisibility;
  /** `null` clears it. */
  password?: string | null;
}

export interface DraftSaved {
  draftRevision: number;
  draftUpdatedAt: string;
}

export interface SiteVersion {
  id: string;
  number: number;
  note: string | null;
  publishedByUserId: string | null;
  createdAt: string;
  isLive: boolean;
}

export interface PreviewLink {
  url: string;
  expiresAt: string;
}

export interface StorePage {
  id: string;
  siteId: string;
  title: string;
  slug: string;
  seoTitle: string | null;
  seoDescription: string | null;
  sections: Section[];
  visible: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePageInput {
  title: string;
  slug?: string;
  sections?: Section[];
}

export interface UpdatePageInput {
  title?: string;
  slug?: string;
  seoTitle?: string | null;
  seoDescription?: string | null;
  sections?: Section[];
  visible?: boolean;
}

export interface StoreMenu {
  handle: string;
  title: string;
  items: MenuItem[];
  updatedAt: string | null;
}

export interface StoreRedirect {
  id: string;
  fromPath: string;
  toPath: string;
  createdAt: string;
}

export type DeploymentStatus = 'uploading' | 'ready' | 'failed';

export interface StoreDeployment {
  id: string;
  siteId: string;
  status: DeploymentStatus;
  fileCount: number;
  totalBytes: number;
  isProduction: boolean;
  previewUrl: string | null;
  createdAt: string;
  promotedAt: string | null;
  createdByUserId: string | null;
  createdByKeyId: string | null;
  error: string | null;
}

/** One file of an upload: `path` is its place in the shop (`assets/app.js`). */
export interface DeploymentFile {
  path: string;
  file: Blob;
}

export interface StorefrontHostsConfig {
  /** Whether free addresses (`{slug}.<baseDomain>`) can be claimed here. */
  available: boolean;
  baseDomain: string;
  cnameTarget: string;
  apexAddresses: string[];
  customDomains: boolean;
}

export type HostKind = 'subdomain' | 'custom';
export type HostStatus = 'pending' | 'active' | 'failed';
export type HostSslStatus = 'issuing' | 'active' | 'failed';

export interface HostDnsRecord {
  type: string;
  name: string;
  value: string;
  purpose: 'ownership' | 'routing';
}

export interface StorefrontHost {
  id: string;
  siteId: string;
  hostname: string;
  kind: HostKind;
  isPrimary: boolean;
  status: HostStatus;
  sslStatus: HostSslStatus | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  url: string;
  dnsRecords: HostDnsRecord[];
  createdAt: string;
}

export type CreateHostInput = { siteId: string; subdomain: string } | { siteId: string; hostname: string };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface ErrorBody {
  code?: string;
  details?: Record<string, unknown>;
}

function errorBody(err: unknown): ErrorBody {
  if (typeof err !== 'object' || err === null) return {};
  const body = (err as { body?: unknown }).body;
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  if (typeof error !== 'object' || error === null) return {};
  const { code, details } = error as { code?: unknown; details?: unknown };
  return {
    code: typeof code === 'string' ? code : undefined,
    details: typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : undefined,
  };
}

/** The revision on the server when a draft save lost the race (409 `REVISION_CONFLICT`); `null` for any other error. */
export function revisionConflict(err: unknown): number | null {
  const { code, details } = errorBody(err);
  if (code !== 'REVISION_CONFLICT') return null;
  const current = details?.currentRevision;
  return typeof current === 'number' ? current : -1;
}

/** The field errors of a 400 `VALIDATION_ERROR` (document path → message); `null` for any other error. */
export function validationFields(err: unknown): Record<string, string> | null {
  const { code, details } = errorBody(err);
  if (code !== 'VALIDATION_ERROR') return null;
  const fields = details?.fields;
  if (typeof fields !== 'object' || fields === null) return {};
  return Object.fromEntries(
    Object.entries(fields as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/** The error code of a failed call (`HOST_TAKEN`, `SITE_EXISTS`, …), if the API sent one. */
export function onlineStoreErrorCode(err: unknown): string | undefined {
  return errorBody(err).code;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export const onlineStoreKeys = {
  all: () => [...commerceKeys.all, 'online-store'] as const,
  sites: () => [...onlineStoreKeys.all(), 'sites'] as const,
  siteList: () => [...onlineStoreKeys.sites(), 'list'] as const,
  site: (siteId: string) => [...onlineStoreKeys.sites(), 'detail', siteId] as const,
  versions: (siteId: string) => [...onlineStoreKeys.all(), 'versions', siteId] as const,
  pages: (siteId: string) => [...onlineStoreKeys.all(), 'pages', siteId] as const,
  page: (siteId: string, pageId: string) => [...onlineStoreKeys.pages(siteId), pageId] as const,
  menus: (siteId: string) => [...onlineStoreKeys.all(), 'menus', siteId] as const,
  redirects: (siteId: string) => [...onlineStoreKeys.all(), 'redirects', siteId] as const,
  deployments: (siteId: string) => [...onlineStoreKeys.all(), 'deployments', siteId] as const,
  hostsConfig: () => [...onlineStoreKeys.all(), 'hosts-config'] as const,
  hosts: (siteId: string) => [...onlineStoreKeys.all(), 'hosts', siteId] as const,
};

const sitePath = (siteId: string) => `/online-store/sites/${siteId}`;

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export function useOnlineStoreSites(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: onlineStoreKeys.siteList(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<OnlineStoreSite[]>>('/online-store/sites');
    },
    enabled,
  });
}

export function useOnlineStoreSite(siteId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: onlineStoreKeys.site(siteId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<OnlineStoreSiteDetail>>(sitePath(siteId));
    },
    enabled: !!siteId && enabled,
  });
}

/** After a site write: every site list and detail. */
function useInvalidateSites() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: onlineStoreKeys.sites() });
}

export function useCreateOnlineStoreSite() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateSites();
  return useMutation({
    mutationFn: async (data: CreateSiteInput) => {
      const client = await getClient();
      return client.post<DataResponse<OnlineStoreSiteDetail>>('/online-store/sites', data);
    },
    onSuccess: invalidate,
  });
}

export function useUpdateOnlineStoreSite() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateSites();
  return useMutation({
    mutationFn: async ({ siteId, data }: { siteId: string; data: UpdateSiteInput }) => {
      const client = await getClient();
      return client.patch<DataResponse<OnlineStoreSite>>(sitePath(siteId), data);
    },
    onSuccess: invalidate,
  });
}

/** Removes the site and its hosts. */
export function useDeleteOnlineStoreSite() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (siteId: string) => {
      const client = await getClient();
      return client.delete<void>(sitePath(siteId));
    },
    onSuccess: (_, siteId) => {
      void qc.invalidateQueries({ queryKey: onlineStoreKeys.sites() });
      void qc.invalidateQueries({ queryKey: onlineStoreKeys.hosts(siteId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Draft, publishing and versions
// ---------------------------------------------------------------------------

/**
 * Saves the draft against the revision it was based on. The editor keeps its
 * own copy of the document, so the cached detail is updated in place (never
 * refetched under the editor) and the lists learn there are unpublished changes.
 */
export function useSaveDraft() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ siteId, document, revision }: { siteId: string; document: SiteDocument; revision: number }) => {
      const client = await getClient();
      return client.put<DataResponse<DraftSaved>>(`${sitePath(siteId)}/draft`, { document, revision });
    },
    onSuccess: (res, vars) => {
      qc.setQueryData<DataResponse<OnlineStoreSiteDetail>>(onlineStoreKeys.site(vars.siteId), (old) =>
        old
          ? {
              ...old,
              data: { ...old.data, draft: vars.document, ...res.data, hasUnpublishedChanges: true },
            }
          : old,
      );
      void qc.invalidateQueries({ queryKey: onlineStoreKeys.siteList() });
    },
  });
}

export function usePublishSite() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ siteId, note }: { siteId: string; note?: string }) => {
      const client = await getClient();
      return client.post<DataResponse<SiteVersion> & { site?: OnlineStoreSite }>(`${sitePath(siteId)}/publish`, note ? { note } : {});
    },
    // The editor reads the detail's draft only once, so refetching it here does not undo edits.
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: onlineStoreKeys.sites() });
      void qc.invalidateQueries({ queryKey: onlineStoreKeys.versions(vars.siteId) });
    },
  });
}

export function useSiteVersions(siteId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: onlineStoreKeys.versions(siteId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<SiteVersion[]>>(`${sitePath(siteId)}/versions`);
    },
    enabled: !!siteId && enabled,
  });
}

/** Makes an earlier version live again; the draft is left alone. */
export function useRestoreSiteVersion() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ siteId, versionId }: { siteId: string; versionId: string }) => {
      const client = await getClient();
      return client.post<DataResponse<OnlineStoreSite>>(`${sitePath(siteId)}/versions/${versionId}/restore`, {});
    },
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: onlineStoreKeys.sites() });
      void qc.invalidateQueries({ queryKey: onlineStoreKeys.versions(vars.siteId) });
    },
  });
}

/** Replaces the draft with an earlier version; the answer carries the new draft and revision. */
export function useCopyVersionToDraft() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ siteId, versionId }: { siteId: string; versionId: string }) => {
      const client = await getClient();
      return client.post<DataResponse<OnlineStoreSiteDetail>>(`${sitePath(siteId)}/versions/${versionId}/copy-to-draft`, {});
    },
    onSuccess: (res, vars) => {
      qc.setQueryData(onlineStoreKeys.site(vars.siteId), res);
      void qc.invalidateQueries({ queryKey: onlineStoreKeys.siteList() });
    },
  });
}

/** A short-lived link that opens the draft in the shop's preview mode. */
export function useCreatePreviewLink() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (siteId: string) => {
      const client = await getClient();
      return client.post<DataResponse<PreviewLink>>(`${sitePath(siteId)}/preview`, {});
    },
  });
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export function useStorePages(siteId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: onlineStoreKeys.pages(siteId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<StorePage[]>>(`${sitePath(siteId)}/pages`);
    },
    enabled: !!siteId && enabled,
  });
}

export function useStorePage(siteId: string, pageId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: onlineStoreKeys.page(siteId, pageId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<StorePage>>(`${sitePath(siteId)}/pages/${pageId}`);
    },
    enabled: !!siteId && !!pageId && enabled,
  });
}

/** After a page write: the site's pages, and the site rows that say whether something is unpublished. */
function useInvalidatePages() {
  const qc = useQueryClient();
  return (siteId: string) => {
    void qc.invalidateQueries({ queryKey: onlineStoreKeys.pages(siteId) });
    void qc.invalidateQueries({ queryKey: onlineStoreKeys.siteList() });
  };
}

export function useCreateStorePage() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidatePages();
  return useMutation({
    mutationFn: async ({ siteId, data }: { siteId: string; data: CreatePageInput }) => {
      const client = await getClient();
      return client.post<DataResponse<StorePage>>(`${sitePath(siteId)}/pages`, data);
    },
    onSuccess: (_, vars) => invalidate(vars.siteId),
  });
}

export function useUpdateStorePage() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  const invalidate = useInvalidatePages();
  return useMutation({
    mutationFn: async ({ siteId, pageId, data }: { siteId: string; pageId: string; data: UpdatePageInput }) => {
      const client = await getClient();
      return client.patch<DataResponse<StorePage>>(`${sitePath(siteId)}/pages/${pageId}`, data);
    },
    onSuccess: (res, vars) => {
      qc.setQueryData(onlineStoreKeys.page(vars.siteId, vars.pageId), res);
      invalidate(vars.siteId);
    },
  });
}

export function useDeleteStorePage() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidatePages();
  return useMutation({
    mutationFn: async ({ siteId, pageId }: { siteId: string; pageId: string }) => {
      const client = await getClient();
      return client.delete<void>(`${sitePath(siteId)}/pages/${pageId}`);
    },
    onSuccess: (_, vars) => invalidate(vars.siteId),
  });
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

export function useStoreMenus(siteId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: onlineStoreKeys.menus(siteId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<StoreMenu[]>>(`${sitePath(siteId)}/menus`);
    },
    enabled: !!siteId && enabled,
  });
}

/** Creates or replaces the menu with this handle. */
export function useSaveStoreMenu() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ siteId, handle, data }: { siteId: string; handle: string; data: { title: string; items: MenuItem[] } }) => {
      const client = await getClient();
      return client.put<DataResponse<StoreMenu>>(`${sitePath(siteId)}/menus/${encodeURIComponent(handle)}`, data);
    },
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: onlineStoreKeys.menus(vars.siteId) });
      void qc.invalidateQueries({ queryKey: onlineStoreKeys.siteList() });
    },
  });
}

/** Not for `main` and `footer`, which always exist. */
export function useDeleteStoreMenu() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ siteId, handle }: { siteId: string; handle: string }) => {
      const client = await getClient();
      return client.delete<void>(`${sitePath(siteId)}/menus/${encodeURIComponent(handle)}`);
    },
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: onlineStoreKeys.menus(vars.siteId) });
      void qc.invalidateQueries({ queryKey: onlineStoreKeys.siteList() });
    },
  });
}

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

export function useStoreRedirects(siteId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: onlineStoreKeys.redirects(siteId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<StoreRedirect[]>>(`${sitePath(siteId)}/redirects`);
    },
    enabled: !!siteId && enabled,
  });
}

export function useCreateStoreRedirect() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ siteId, data }: { siteId: string; data: { fromPath: string; toPath: string } }) => {
      const client = await getClient();
      return client.post<DataResponse<StoreRedirect>>(`${sitePath(siteId)}/redirects`, data);
    },
    onSuccess: (_, vars) => void qc.invalidateQueries({ queryKey: onlineStoreKeys.redirects(vars.siteId) }),
  });
}

export function useDeleteStoreRedirect() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ siteId, redirectId }: { siteId: string; redirectId: string }) => {
      const client = await getClient();
      return client.delete<void>(`${sitePath(siteId)}/redirects/${redirectId}`);
    },
    onSuccess: (_, vars) => void qc.invalidateQueries({ queryKey: onlineStoreKeys.redirects(vars.siteId) }),
  });
}

// ---------------------------------------------------------------------------
// Deployments (static mode)
// ---------------------------------------------------------------------------

export function useStoreDeployments(siteId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: onlineStoreKeys.deployments(siteId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<StoreDeployment[]>>(`${sitePath(siteId)}/deployments`);
    },
    enabled: !!siteId && enabled,
  });
}

/** After a deployment write: the list, and the sites (their active deployment). */
function useInvalidateDeployments() {
  const qc = useQueryClient();
  return (siteId: string) => {
    void qc.invalidateQueries({ queryKey: onlineStoreKeys.deployments(siteId) });
    void qc.invalidateQueries({ queryKey: onlineStoreKeys.sites() });
  };
}

/** Uploads a build: one `files` part per file, named by its path, and the optional `weldstorefront.json`. */
export function useUploadDeployment() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateDeployments();
  return useMutation({
    mutationFn: async ({ siteId, files, config }: { siteId: string; files: DeploymentFile[]; config?: Blob }) => {
      const form = new FormData();
      for (const { path, file } of files) form.append('files', file, path);
      if (config) form.append('config', config, 'weldstorefront.json');
      const client = await getClient();
      return client.postForm<DataResponse<StoreDeployment>>(`${sitePath(siteId)}/deployments`, form);
    },
    onSuccess: (_, vars) => invalidate(vars.siteId),
  });
}

export function usePromoteDeployment() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateDeployments();
  return useMutation({
    mutationFn: async ({ siteId, deploymentId }: { siteId: string; deploymentId: string }) => {
      const client = await getClient();
      return client.post<DataResponse<StoreDeployment>>(`${sitePath(siteId)}/deployments/${deploymentId}/promote`, {});
    },
    onSuccess: (_, vars) => invalidate(vars.siteId),
  });
}

/** Not the production deployment. */
export function useDeleteDeployment() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateDeployments();
  return useMutation({
    mutationFn: async ({ siteId, deploymentId }: { siteId: string; deploymentId: string }) => {
      const client = await getClient();
      return client.delete<void>(`${sitePath(siteId)}/deployments/${deploymentId}`);
    },
    onSuccess: (_, vars) => invalidate(vars.siteId),
  });
}

// ---------------------------------------------------------------------------
// Hosts (free address and custom domains)
// ---------------------------------------------------------------------------

export function useStorefrontHostsConfig(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: onlineStoreKeys.hostsConfig(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<StorefrontHostsConfig>>('/storefront-hosts/config');
    },
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

export function useStorefrontHosts(siteId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: onlineStoreKeys.hosts(siteId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<StorefrontHost[]>>(`/storefront-hosts?siteId=${encodeURIComponent(siteId)}`);
    },
    enabled: !!siteId && enabled,
  });
}

/** After a host write: the site's hosts, and the sites (their primary address). */
function useInvalidateHosts() {
  const qc = useQueryClient();
  return (siteId: string) => {
    void qc.invalidateQueries({ queryKey: onlineStoreKeys.hosts(siteId) });
    void qc.invalidateQueries({ queryKey: onlineStoreKeys.sites() });
  };
}

/** Claims the free address (`{ subdomain }`) or adds a custom domain (`{ hostname }`). */
export function useCreateStorefrontHost() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateHosts();
  return useMutation({
    mutationFn: async (data: CreateHostInput) => {
      const client = await getClient();
      return client.post<DataResponse<StorefrontHost>>('/storefront-hosts', data);
    },
    onSuccess: (_, vars) => invalidate(vars.siteId),
  });
}

/** Checks the DNS records and certificate again now. */
export function useRefreshStorefrontHost() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateHosts();
  return useMutation({
    mutationFn: async ({ hostId }: { siteId: string; hostId: string }) => {
      const client = await getClient();
      return client.post<DataResponse<StorefrontHost>>(`/storefront-hosts/${hostId}/refresh`, {});
    },
    onSuccess: (_, vars) => invalidate(vars.siteId),
  });
}

export function useMakeStorefrontHostPrimary() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateHosts();
  return useMutation({
    mutationFn: async ({ hostId }: { siteId: string; hostId: string }) => {
      const client = await getClient();
      return client.post<DataResponse<StorefrontHost>>(`/storefront-hosts/${hostId}/primary`, {});
    },
    onSuccess: (_, vars) => invalidate(vars.siteId),
  });
}

export function useDeleteStorefrontHost() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateHosts();
  return useMutation({
    mutationFn: async ({ hostId }: { siteId: string; hostId: string }) => {
      const client = await getClient();
      return client.delete<void>(`/storefront-hosts/${hostId}`);
    },
    onSuccess: (_, vars) => invalidate(vars.siteId),
  });
}
