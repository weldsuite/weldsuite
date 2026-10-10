/**
 * Partner portal hooks (`/api/partner/*`) and the workspace-facing partner
 * endpoints (managed billing, territory requests).
 *
 * Portal data is financial and per-partner, so none of it is written to the
 * persisted query cache (`meta.persist: false`). Keys carry the partner id, so
 * switching partner never shows the other one's data.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import type {
  CreateManagedWorkspaceBody,
  LicencePackageBody,
  LicenceStatusChangeBody,
  PartnerCreditGrantBody,
  PartnerMemberInviteBody,
  PartnerMemberUpdateBody,
  PartnerRequestUpdateBody,
  PartnerSettingsBody,
  PartnerWorkspaceRequestBody,
  WorkspaceLicenceBody,
} from '@weldsuite/app-api-client/domains/partners';
import { useAppApi } from '@/lib/api/use-app-api';
import { partnerKeys } from '@/lib/partner/partner-api';
import { usePartnerContext } from '@/lib/partner/partner-context';

const NO_PERSIST = { persist: false } as const;

// ---------------------------------------------------------------------------
// Portal reads
// ---------------------------------------------------------------------------

export function usePartnerOverview() {
  const { partnerId, clients } = usePartnerContext();
  return useQuery({
    queryKey: partnerKeys.overview(partnerId),
    queryFn: () => clients.portal.overview(),
    select: (res) => res.data,
    meta: NO_PERSIST,
  });
}

const WORKSPACES_PAGE_SIZE = 50;

/**
 * The partner's workspaces, a page at a time (`cursor` is the server's offset).
 * Search runs on the server (`q`), so it covers workspaces that are not loaded yet.
 */
export function usePartnerWorkspaces(opts: { q?: string } = {}) {
  const { partnerId, clients } = usePartnerContext();
  const q = opts.q?.trim() || undefined;
  return useInfiniteQuery({
    queryKey: [...partnerKeys.workspaces(partnerId), { q: q ?? '' }],
    queryFn: ({ pageParam }) =>
      clients.portal.listWorkspaces({ q, limit: WORKSPACES_PAGE_SIZE, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.pagination.hasMore ? last.pagination.cursor : undefined),
    select: (data) => ({
      rows: data.pages.flatMap((page) => page.data),
      totalCount: data.pages[0]?.pagination.totalCount ?? 0,
    }),
    meta: NO_PERSIST,
  });
}

export function usePartnerWorkspace(workspaceId: string | undefined) {
  const { partnerId, clients } = usePartnerContext();
  return useQuery({
    queryKey: partnerKeys.workspace(partnerId, workspaceId ?? ''),
    queryFn: () => clients.portal.getWorkspace(workspaceId as string),
    select: (res) => res.data,
    enabled: Boolean(workspaceId),
    meta: NO_PERSIST,
  });
}

export function usePartnerPackages(opts: { archived?: boolean } = {}) {
  const { partnerId, clients } = usePartnerContext();
  const archived = opts.archived ?? false;
  return useQuery({
    queryKey: partnerKeys.packages(partnerId, archived),
    queryFn: () => clients.portal.listPackages({ archived }),
    select: (res) => res.data,
    meta: NO_PERSIST,
  });
}

/** Apps and feature plans the licence editor can offer. */
export function usePartnerCatalog() {
  const { partnerId, clients } = usePartnerContext();
  return useQuery({
    queryKey: partnerKeys.catalog(partnerId),
    queryFn: () => clients.portal.catalog(),
    select: (res) => res.data,
    staleTime: 5 * 60 * 1000,
    meta: NO_PERSIST,
  });
}

export function usePartnerStatements(enabled = true) {
  const { partnerId, clients } = usePartnerContext();
  return useQuery({
    queryKey: partnerKeys.statements(partnerId),
    queryFn: () => clients.portal.listStatements(),
    select: (res) => res.data,
    enabled,
    meta: NO_PERSIST,
  });
}

/** `statementId` may be `current` for the live preview. */
export function usePartnerStatement(statementId: string | undefined, enabled = true) {
  const { partnerId, clients } = usePartnerContext();
  return useQuery({
    queryKey: partnerKeys.statement(partnerId, statementId ?? ''),
    queryFn: () =>
      statementId === 'current' ? clients.portal.currentStatement() : clients.portal.getStatement(statementId as string),
    select: (res) => res.data,
    enabled: enabled && Boolean(statementId),
    meta: NO_PERSIST,
  });
}

export function usePartnerRequests(enabled = true) {
  const { partnerId, clients } = usePartnerContext();
  return useQuery({
    queryKey: partnerKeys.requests(partnerId),
    queryFn: () => clients.portal.listRequests(),
    select: (res) => res.data,
    enabled,
    meta: NO_PERSIST,
  });
}

export function usePartnerTeam() {
  const { partnerId, clients } = usePartnerContext();
  return useQuery({
    queryKey: partnerKeys.team(partnerId),
    queryFn: () => clients.portal.listTeam(),
    select: (res) => res.data,
    meta: NO_PERSIST,
  });
}

export function usePartnerSettings() {
  const { partnerId, clients } = usePartnerContext();
  return useQuery({
    queryKey: partnerKeys.settings(partnerId),
    queryFn: () => clients.portal.getSettings(),
    select: (res) => res.data,
    meta: NO_PERSIST,
  });
}

// ---------------------------------------------------------------------------
// Portal writes
// ---------------------------------------------------------------------------

/** A licence change moves the estimate, the overview and the statement preview. */
function useInvalidateMoney() {
  const qc = useQueryClient();
  const { partnerId } = usePartnerContext();
  return () => {
    void qc.invalidateQueries({ queryKey: partnerKeys.workspaces(partnerId) });
    void qc.invalidateQueries({ queryKey: partnerKeys.overview(partnerId) });
    void qc.invalidateQueries({ queryKey: partnerKeys.statements(partnerId) });
    void qc.invalidateQueries({ queryKey: [...partnerKeys.scope(partnerId), 'workspace'] });
  };
}

export function useCreateManagedWorkspace() {
  const { clients, partnerId } = usePartnerContext();
  const qc = useQueryClient();
  const invalidateMoney = useInvalidateMoney();
  return useMutation({
    mutationFn: (body: CreateManagedWorkspaceBody) => clients.portal.createWorkspace(body),
    onSuccess: () => {
      invalidateMoney();
      void qc.invalidateQueries({ queryKey: partnerKeys.requests(partnerId) });
    },
  });
}

export function useSetWorkspaceLicence(workspaceId: string) {
  const { clients } = usePartnerContext();
  const invalidateMoney = useInvalidateMoney();
  return useMutation({
    mutationFn: (body: WorkspaceLicenceBody) => clients.portal.setLicence(workspaceId, body),
    onSuccess: invalidateMoney,
  });
}

export function useSetLicenceStatus(workspaceId: string) {
  const { clients } = usePartnerContext();
  const invalidateMoney = useInvalidateMoney();
  return useMutation({
    mutationFn: (body: LicenceStatusChangeBody) => clients.portal.setLicenceStatus(workspaceId, body),
    onSuccess: invalidateMoney,
  });
}

/**
 * The server requires an `Idempotency-Key`. The caller generates one per
 * dialog opening and reuses it on a retry, so a double click or a network retry
 * cannot grant twice.
 */
export function useGrantCredits(workspaceId: string) {
  const { clients } = usePartnerContext();
  const invalidateMoney = useInvalidateMoney();
  return useMutation({
    mutationFn: (vars: { body: PartnerCreditGrantBody; idempotencyKey: string }) =>
      clients.portalWith({ 'Idempotency-Key': vars.idempotencyKey }).grantCredits(workspaceId, vars.body),
    onSuccess: invalidateMoney,
  });
}

function usePackagesInvalidate() {
  const qc = useQueryClient();
  const { partnerId } = usePartnerContext();
  return () => {
    void qc.invalidateQueries({ queryKey: [...partnerKeys.scope(partnerId), 'packages'] });
  };
}

export function useCreatePackage() {
  const { clients } = usePartnerContext();
  const invalidate = usePackagesInvalidate();
  return useMutation({
    mutationFn: (body: LicencePackageBody) => clients.portal.createPackage(body),
    onSuccess: invalidate,
  });
}

export function useUpdatePackage() {
  const { clients } = usePartnerContext();
  const invalidate = usePackagesInvalidate();
  return useMutation({
    mutationFn: (vars: { packageId: string; body: LicencePackageBody }) =>
      clients.portal.updatePackage(vars.packageId, vars.body),
    onSuccess: invalidate,
  });
}

export function useArchivePackage() {
  const { clients } = usePartnerContext();
  const invalidate = usePackagesInvalidate();
  return useMutation({
    mutationFn: (packageId: string) => clients.portal.archivePackage(packageId),
    onSuccess: invalidate,
  });
}

export function useUpdatePartnerRequest() {
  const { clients, partnerId } = usePartnerContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { requestId: string; body: PartnerRequestUpdateBody }) =>
      clients.portal.updateRequest(vars.requestId, vars.body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: partnerKeys.requests(partnerId) });
    },
  });
}

export function useInvitePartnerMember() {
  const { clients, partnerId } = usePartnerContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PartnerMemberInviteBody) => clients.portal.inviteMember(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: partnerKeys.team(partnerId) });
    },
  });
}

export function useUpdatePartnerMember() {
  const { clients, partnerId } = usePartnerContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { memberId: string; body: PartnerMemberUpdateBody }) =>
      clients.portal.updateMember(vars.memberId, vars.body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: partnerKeys.team(partnerId) });
      void qc.invalidateQueries({ queryKey: partnerKeys.all });
    },
  });
}

export function useRemovePartnerMember() {
  const { clients, partnerId } = usePartnerContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) => clients.portal.removeMember(memberId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: partnerKeys.team(partnerId) });
    },
  });
}

export function useUpdatePartnerSettings() {
  const { clients, partnerId } = usePartnerContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PartnerSettingsBody) => clients.portal.updateSettings(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: partnerKeys.settings(partnerId) });
      void qc.invalidateQueries({ queryKey: partnerKeys.overview(partnerId) });
    },
  });
}

/** Resolves to the CSV text; the caller turns it into a download. */
export function useStatementCsv() {
  const { clients } = usePartnerContext();
  return useMutation({
    mutationFn: (statementId: string) => clients.portal.statementCsv(statementId),
  });
}

// ---------------------------------------------------------------------------
// Workspace-facing (not the portal): any member of a workspace may call these
// ---------------------------------------------------------------------------

/**
 * `GET /api/billing/managed`: the licence of a partner-managed workspace, or
 * `null` for a workspace that is billed directly. Read by the settings pages,
 * the read-only / past-due banners and the App Store, so it is one shared query.
 * A failing request counts as "not managed" rather than blocking the page.
 */
export function useManagedBilling() {
  const { orgId } = useAuth();
  const { partners } = useAppApi();
  return useQuery({
    queryKey: partnerKeys.managedBilling(orgId),
    queryFn: () => partners.managedBilling(),
    select: (res) => res.data ?? null,
    enabled: Boolean(orgId),
    staleTime: 60 * 1000,
    retry: false,
  });
}

/** Territory signup: ask the partner for a workspace. Works without an active workspace. */
export function useSubmitPartnerRequest() {
  const { partners } = useAppApi();
  return useMutation({
    mutationFn: (body: PartnerWorkspaceRequestBody) => partners.submitWorkspaceRequest(body),
  });
}
