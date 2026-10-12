/**
 * App-API partners domain client — the reseller portal (`/api/partner/*`) plus
 * the few workspace-facing endpoints that belong to the same feature
 * (`/api/billing/managed`, `/api/onboarding/partner-request`).
 *
 * Portal calls need the `X-Partner-Id` header once a user belongs to more than
 * one partner. The header is a property of the client, not of each call: build
 * the `ClientApi` with `getExtraHeaders` (see `usePartnerApi` in the platform)
 * and pass it here. `GET /partner/me` works without it.
 *
 * Plan: docs/plans/reseller-licensing.md. Contract: `../schemas/partners`.
 */

import type { z } from 'zod';
import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  createManagedWorkspaceSchema,
  licencePackageSchema,
  licenceStatusChangeSchema,
  ManagedBillingInfo,
  ManagedWorkspaceDetail,
  ManagedWorkspaceRow,
  PartnerCatalog,
  PartnerCreditGrantResult,
  partnerCreditGrantSchema,
  partnerMemberInviteSchema,
  partnerMemberUpdateSchema,
  PartnerMembership,
  PartnerOverview,
  PartnerLicencePackageView,
  PartnerPublicInfo,
  partnerRequestUpdateSchema,
  partnerSettingsSchema,
  PartnerStatementView,
  PartnerTeamMember,
  partnerWorkspaceRequestSchema,
  PartnerWorkspaceRequestView,
  WorkspaceLicenceStatus,
  workspaceLicenceInputSchema,
} from '../schemas/partners';

// ---------------------------------------------------------------------------
// Request inputs (Zod input types: defaulted fields may be omitted)
// ---------------------------------------------------------------------------

export type CreateManagedWorkspaceBody = z.input<typeof createManagedWorkspaceSchema>;
export type WorkspaceLicenceBody = z.input<typeof workspaceLicenceInputSchema>;
export type LicenceStatusChangeBody = z.input<typeof licenceStatusChangeSchema>;
export type PartnerCreditGrantBody = z.input<typeof partnerCreditGrantSchema>;
export type LicencePackageBody = z.input<typeof licencePackageSchema>;
export type PartnerMemberInviteBody = z.input<typeof partnerMemberInviteSchema>;
export type PartnerMemberUpdateBody = z.input<typeof partnerMemberUpdateSchema>;
export type PartnerSettingsBody = z.input<typeof partnerSettingsSchema>;
export type PartnerRequestUpdateBody = z.input<typeof partnerRequestUpdateSchema>;
export type PartnerWorkspaceRequestBody = z.input<typeof partnerWorkspaceRequestSchema>;

// ---------------------------------------------------------------------------
// Response shapes: defined in the shared contract, re-exported under the names
// the platform uses.
// ---------------------------------------------------------------------------

export type {
  ManagedWorkspaceDetail,
  PartnerCatalog,
  PartnerCreditGrantResult,
  PartnerOverview,
  PartnerTeamMember,
} from '../schemas/partners';
export type { PartnerLicencePackageView as PartnerLicencePackage } from '../schemas/partners';
export type { PartnerWorkspaceRequestView as PartnerWorkspaceRequest } from '../schemas/partners';

/** `GET /partner/workspaces` filters. `cursor` is the offset from the previous page's pagination. */
export interface ListManagedWorkspacesParams {
  q?: string;
  status?: WorkspaceLicenceStatus;
  limit?: number;
  cursor?: string | null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function createPartnersApi(api: ClientApi) {
  return {
    /** The caller's partner memberships. Empty for everyone who is not a partner. */
    me: () => api.get<DataResponse<PartnerMembership[]>>('/partner/me'),
    overview: () => api.get<DataResponse<PartnerOverview>>('/partner/overview'),

    // Workspaces
    listWorkspaces: (params: ListManagedWorkspacesParams = {}) =>
      api.get<ListResponse<ManagedWorkspaceRow>>(`/partner/workspaces${buildQueryString({ ...params })}`),
    createWorkspace: (body: CreateManagedWorkspaceBody) =>
      api.post<DataResponse<{ workspaceId: string }>>('/partner/workspaces', body),
    getWorkspace: (workspaceId: string) =>
      api.get<DataResponse<ManagedWorkspaceDetail>>(`/partner/workspaces/${workspaceId}`),
    setLicence: (workspaceId: string, body: WorkspaceLicenceBody) =>
      api.put<DataResponse<ManagedWorkspaceRow>>(`/partner/workspaces/${workspaceId}/licence`, body),
    setLicenceStatus: (workspaceId: string, body: LicenceStatusChangeBody) =>
      api.post<DataResponse<ManagedWorkspaceRow>>(`/partner/workspaces/${workspaceId}/status`, body),
    /** The server requires an `Idempotency-Key` header: send it via the client's extra headers. */
    grantCredits: (workspaceId: string, body: PartnerCreditGrantBody) =>
      api.post<DataResponse<PartnerCreditGrantResult>>(`/partner/workspaces/${workspaceId}/credits`, body),

    // Packages
    listPackages: (opts: { archived?: boolean } = {}) =>
      api.get<DataResponse<PartnerLicencePackageView[]>>(`/partner/packages${opts.archived ? '?archived=true' : ''}`),
    createPackage: (body: LicencePackageBody) =>
      api.post<DataResponse<PartnerLicencePackageView>>('/partner/packages', body),
    updatePackage: (packageId: string, body: LicencePackageBody) =>
      api.put<DataResponse<PartnerLicencePackageView>>(`/partner/packages/${packageId}`, body),
    archivePackage: (packageId: string) => api.delete<void>(`/partner/packages/${packageId}`),
    catalog: () => api.get<DataResponse<PartnerCatalog>>('/partner/catalog'),

    // Statements. The first list item is the live current-month preview (`id: null`).
    listStatements: () => api.get<DataResponse<PartnerStatementView[]>>('/partner/statements'),
    currentStatement: () => api.get<DataResponse<PartnerStatementView>>('/partner/statements/current'),
    getStatement: (statementId: string) =>
      api.get<DataResponse<PartnerStatementView>>(`/partner/statements/${statementId}`),
    /** `statementId` may be `current`. Resolves to the CSV text. */
    statementCsv: async (statementId: string): Promise<string> => {
      const res = await api.getRaw(`/partner/statements/${statementId}/csv`);
      return res.text();
    },

    // Requests
    listRequests: () => api.get<DataResponse<PartnerWorkspaceRequestView[]>>('/partner/requests'),
    updateRequest: (requestId: string, body: PartnerRequestUpdateBody) =>
      api.patch<DataResponse<PartnerWorkspaceRequestView>>(`/partner/requests/${requestId}`, body),

    // Team
    listTeam: () => api.get<DataResponse<PartnerTeamMember[]>>('/partner/team'),
    inviteMember: (body: PartnerMemberInviteBody) =>
      api.post<DataResponse<PartnerTeamMember>>('/partner/team', body),
    updateMember: (memberId: string, body: PartnerMemberUpdateBody) =>
      api.patch<DataResponse<PartnerTeamMember>>(`/partner/team/${memberId}`, body),
    removeMember: (memberId: string) => api.delete<void>(`/partner/team/${memberId}`),

    // Settings
    getSettings: () => api.get<DataResponse<PartnerPublicInfo>>('/partner/settings'),
    updateSettings: (body: PartnerSettingsBody) =>
      api.patch<DataResponse<PartnerPublicInfo>>('/partner/settings', body),

    // Workspace-facing (not portal) endpoints of the same feature.
    /** `null` for a workspace that is billed directly. */
    managedBilling: () => api.get<DataResponse<ManagedBillingInfo | null>>('/billing/managed'),
    /** A territory signup asks the partner for a workspace. Needs no active workspace. */
    submitWorkspaceRequest: (body: PartnerWorkspaceRequestBody) =>
      api.post<DataResponse<{ id: string }>>('/onboarding/partner-request', body),
  };
}

export type PartnersApi = ReturnType<typeof createPartnersApi>;
