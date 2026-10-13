/**
 * App-API WeldReach domain client — `/api/reach/*` (reach-api).
 *
 * Every route is refused (403 APP_ACCESS_REQUIRED) until WeldSuite staff have
 * approved the workspace; the access request itself goes through
 * `createAppAccessApi` (app-api). Mailbox credentials never travel here.
 * See docs/plans/weldreach.md.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  AddReachCampaignProspectsInput,
  ConnectReachDomainInput,
  CreateReachCampaignInput,
  CreateReachMailboxInput,
  ImportReachProspectsInput,
  ReachAccessSummary,
  ReachAddProspectsReport,
  ReachAddToCrmInput,
  ReachBillingSetupInput,
  ReachBillingSummary,
  ReachCampaign,
  ReachCampaignDetail,
  ReachCampaignStatus,
  ReachCampaignStepStats,
  ReachDomain,
  ReachDomainCandidate,
  ReachEnrollment,
  ReachEnrollmentStatus,
  ReachImportReport,
  ReachInboxFilter,
  ReachMailbox,
  ReachMailboxStatus,
  ReachMessage,
  ReachOverview,
  ReachProspect,
  ReachProspectInput,
  ReachProspectList,
  ReachProspectValidation,
  ReachRenderedPreview,
  ReachSettings,
  ReachStepInput,
  ReachSuppression,
  ReachThread,
  ReachThreadSummary,
  UpdateReachCampaignInput,
  UpdateReachMailboxInput,
  UpdateReachMessageInput,
  UpdateReachProspectInput,
  UpdateReachSettingsInput,
} from '../schemas/reach';

const base = '/reach';

// A type alias (not an interface) so it satisfies buildQueryString's Record<string, unknown>.
export type ReachListParams = {
  cursor?: string;
  limit?: number;
  search?: string;
};

export function createReachApi(api: ClientApi) {
  return {
    // ── Access, settings, overview ─────────────────────────────────────
    access(): Promise<DataResponse<ReachAccessSummary>> {
      return api.get(`${base}/access`);
    },
    overview(): Promise<DataResponse<ReachOverview>> {
      return api.get(`${base}/overview`);
    },
    getSettings(): Promise<DataResponse<ReachSettings>> {
      return api.get(`${base}/settings`);
    },
    updateSettings(input: UpdateReachSettingsInput): Promise<DataResponse<ReachSettings>> {
      return api.patch(`${base}/settings`, input);
    },

    // ── Billing (inbox subscription) ───────────────────────────────────
    billing(): Promise<DataResponse<ReachBillingSummary>> {
      return api.get(`${base}/billing`);
    },
    /** Stripe Checkout (setup mode) to add a payment method. */
    billingSetup(input: ReachBillingSetupInput): Promise<DataResponse<{ url: string }>> {
      return api.post(`${base}/billing/setup`, input);
    },

    // ── Domains (WeldHost domains connected to Mailpool) ───────────────
    listDomains(): Promise<ListResponse<ReachDomain>> {
      return api.get(`${base}/domains`);
    },
    domainCandidates(): Promise<ListResponse<ReachDomainCandidate>> {
      return api.get(`${base}/domains/candidates`);
    },
    connectDomain(input: ConnectReachDomainInput): Promise<DataResponse<ReachDomain>> {
      return api.post(`${base}/domains`, input);
    },
    getDomain(id: string): Promise<DataResponse<ReachDomain>> {
      return api.get(`${base}/domains/${id}`);
    },
    refreshDomainDns(id: string): Promise<DataResponse<ReachDomain>> {
      return api.post(`${base}/domains/${id}/refresh-dns`, {});
    },
    /** 409 while the domain still has mailboxes. */
    disconnectDomain(id: string): Promise<void> {
      return api.delete(`${base}/domains/${id}`);
    },

    // ── Mailboxes ──────────────────────────────────────────────────────
    listMailboxes(params: { domainId?: string; status?: ReachMailboxStatus } = {}): Promise<ListResponse<ReachMailbox>> {
      return api.get(`${base}/mailboxes${buildQueryString(params)}`);
    },
    createMailbox(input: CreateReachMailboxInput): Promise<DataResponse<ReachMailbox>> {
      return api.post(`${base}/mailboxes`, input);
    },
    getMailbox(id: string): Promise<DataResponse<ReachMailbox>> {
      return api.get(`${base}/mailboxes/${id}`);
    },
    updateMailbox(id: string, input: UpdateReachMailboxInput): Promise<DataResponse<ReachMailbox>> {
      return api.patch(`${base}/mailboxes/${id}`, input);
    },
    pauseMailbox(id: string): Promise<DataResponse<ReachMailbox>> {
      return api.post(`${base}/mailboxes/${id}/pause`, {});
    },
    resumeMailbox(id: string): Promise<DataResponse<ReachMailbox>> {
      return api.post(`${base}/mailboxes/${id}/resume`, {});
    },
    deleteMailbox(id: string): Promise<void> {
      return api.delete(`${base}/mailboxes/${id}`);
    },

    // ── Prospects and lists ────────────────────────────────────────────
    listProspects(
      params: ReachListParams & { listId?: string; validation?: ReachProspectValidation } = {},
    ): Promise<ListResponse<ReachProspect>> {
      return api.get(`${base}/prospects${buildQueryString(params)}`);
    },
    createProspect(input: ReachProspectInput & { listId?: string }): Promise<DataResponse<ReachProspect>> {
      return api.post(`${base}/prospects`, input);
    },
    updateProspect(id: string, input: UpdateReachProspectInput): Promise<DataResponse<ReachProspect>> {
      return api.patch(`${base}/prospects/${id}`, input);
    },
    deleteProspect(id: string): Promise<void> {
      return api.delete(`${base}/prospects/${id}`);
    },
    importProspects(input: ImportReachProspectsInput): Promise<DataResponse<ReachImportReport>> {
      return api.post(`${base}/prospects/import`, input);
    },
    importFromCrmList(input: { crmListId: string; listName?: string }): Promise<DataResponse<ReachImportReport>> {
      return api.post(`${base}/prospects/import-crm-list`, input);
    },
    importFromWeldData(input: { welddataListId: string; listName?: string }): Promise<DataResponse<ReachImportReport>> {
      return api.post(`${base}/prospects/import-welddata`, input);
    },
    listLists(): Promise<ListResponse<ReachProspectList>> {
      return api.get(`${base}/lists`);
    },
    createList(input: { name: string; description?: string }): Promise<DataResponse<ReachProspectList>> {
      return api.post(`${base}/lists`, input);
    },
    updateList(id: string, input: { name?: string; description?: string }): Promise<DataResponse<ReachProspectList>> {
      return api.patch(`${base}/lists/${id}`, input);
    },
    deleteList(id: string): Promise<void> {
      return api.delete(`${base}/lists/${id}`);
    },
    addListMembers(id: string, prospectIds: string[]): Promise<DataResponse<{ added: number }>> {
      return api.post(`${base}/lists/${id}/members`, { prospectIds });
    },
    removeListMembers(id: string, prospectIds: string[]): Promise<DataResponse<{ removed: number }>> {
      return api.post(`${base}/lists/${id}/members/remove`, { prospectIds });
    },

    // ── Campaigns ──────────────────────────────────────────────────────
    listCampaigns(params: ReachListParams & { status?: ReachCampaignStatus } = {}): Promise<ListResponse<ReachCampaign>> {
      return api.get(`${base}/campaigns${buildQueryString(params)}`);
    },
    createCampaign(input: CreateReachCampaignInput): Promise<DataResponse<ReachCampaignDetail>> {
      return api.post(`${base}/campaigns`, input);
    },
    getCampaign(id: string): Promise<DataResponse<ReachCampaignDetail>> {
      return api.get(`${base}/campaigns/${id}`);
    },
    updateCampaign(id: string, input: UpdateReachCampaignInput): Promise<DataResponse<ReachCampaignDetail>> {
      return api.patch(`${base}/campaigns/${id}`, input);
    },
    deleteCampaign(id: string): Promise<void> {
      return api.delete(`${base}/campaigns/${id}`);
    },
    /** Replaces all steps. Refused (409) while the campaign is active: pause it first. */
    replaceSteps(id: string, steps: ReachStepInput[]): Promise<DataResponse<ReachCampaignDetail>> {
      return api.put(`${base}/campaigns/${id}/steps`, { steps });
    },
    setMailboxes(id: string, mailboxIds: string[]): Promise<DataResponse<ReachCampaignDetail>> {
      return api.put(`${base}/campaigns/${id}/mailboxes`, { mailboxIds });
    },
    addProspects(id: string, input: AddReachCampaignProspectsInput): Promise<DataResponse<ReachAddProspectsReport>> {
      return api.post(`${base}/campaigns/${id}/prospects`, input);
    },
    listEnrollments(
      id: string,
      params: ReachListParams & { status?: ReachEnrollmentStatus } = {},
    ): Promise<ListResponse<ReachEnrollment>> {
      return api.get(`${base}/campaigns/${id}/enrollments${buildQueryString(params)}`);
    },
    removeEnrollment(id: string, enrollmentId: string): Promise<void> {
      return api.delete(`${base}/campaigns/${id}/enrollments/${enrollmentId}`);
    },
    launch(id: string): Promise<DataResponse<ReachCampaignDetail>> {
      return api.post(`${base}/campaigns/${id}/launch`, {});
    },
    pause(id: string): Promise<DataResponse<ReachCampaignDetail>> {
      return api.post(`${base}/campaigns/${id}/pause`, {});
    },
    resume(id: string): Promise<DataResponse<ReachCampaignDetail>> {
      return api.post(`${base}/campaigns/${id}/resume`, {});
    },
    preview(
      id: string,
      input: { stepId?: string; prospectId?: string; subject?: string; body?: string },
    ): Promise<DataResponse<ReachRenderedPreview>> {
      return api.post(`${base}/campaigns/${id}/preview`, input);
    },
    stepStats(id: string): Promise<DataResponse<ReachCampaignStepStats[]>> {
      return api.get(`${base}/campaigns/${id}/stats`);
    },

    // ── Reply inbox ────────────────────────────────────────────────────
    listThreads(filter: ReachInboxFilter = {}): Promise<ListResponse<ReachThreadSummary>> {
      return api.get(`${base}/inbox${buildQueryString(filter)}`);
    },
    unreadCount(): Promise<DataResponse<{ count: number }>> {
      return api.get(`${base}/inbox/unread-count`);
    },
    getThread(threadKey: string): Promise<DataResponse<ReachThread>> {
      return api.get(`${base}/inbox/threads/${encodeURIComponent(threadKey)}`);
    },
    reply(threadKey: string, body: string): Promise<DataResponse<ReachMessage>> {
      return api.post(`${base}/inbox/threads/${encodeURIComponent(threadKey)}/reply`, { body });
    },
    updateMessage(id: string, input: UpdateReachMessageInput): Promise<DataResponse<ReachMessage>> {
      return api.patch(`${base}/inbox/messages/${id}`, input);
    },
    addToCrm(threadKey: string, input: ReachAddToCrmInput = {}): Promise<DataResponse<{ personId: string; opportunityId: string | null }>> {
      return api.post(`${base}/inbox/threads/${encodeURIComponent(threadKey)}/add-to-crm`, input);
    },

    // ── Suppressions ───────────────────────────────────────────────────
    listSuppressions(params: ReachListParams = {}): Promise<ListResponse<ReachSuppression>> {
      return api.get(`${base}/suppressions${buildQueryString(params)}`);
    },
    addSuppressions(values: string[]): Promise<DataResponse<{ added: number }>> {
      return api.post(`${base}/suppressions`, { values });
    },
    deleteSuppression(id: string): Promise<void> {
      return api.delete(`${base}/suppressions/${id}`);
    },
  };
}

export type ReachApi = ReturnType<typeof createReachApi>;
