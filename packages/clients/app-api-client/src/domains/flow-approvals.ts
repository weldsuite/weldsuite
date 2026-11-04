/**
 * App-API WeldFlow client for approvals, change requests and baselines
 * (project-control slice A): `/api/approvals` (My reviews, Sent by me, Done,
 * answering, delegation, the sponsor), `/api/project-changes` (change requests
 * and the approval rules) and `/api/project-baselines`, plus the risk
 * acceptance request of `/api/project-raid`. Served by flow-api.
 *
 * Request and response shapes are the shared Zod schemas in
 * `../schemas/flow-approvals`, which flow-api validates against.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  Baseline,
  BaselineComparison,
  ChangeControlResponse,
  ChangeControlSettingsInput,
  ChangeRequest,
  ChangeRequestDetail,
  ChangeRequestStatusValue,
  CreateChangeRequestInput,
  CreateDelegationInput,
  DecideApprovalInput,
  DecideResult,
  Delegation,
  Delegations,
  MyReviews,
  RequestRiskAcceptanceInput,
  ReviewApprover,
  ReviewItem,
  ReviewType,
  SentReview,
  SetSponsorInput,
  SubmitChangeResult,
  UpdateChangeRequestInput,
} from '../schemas/flow-approvals';

export type {
  ApprovalAnswer,
  ApprovalDecisionValue,
  ApprovalSubjectType,
  Baseline,
  BaselineComparison,
  BaselineDiff,
  BaselineSnapshotShape,
  ChangeControlResponse,
  ChangeControlSettingsInput,
  ChangeEffects,
  ChangeRequest,
  ChangeRequestDetail,
  ChangeRequestStatusValue,
  ChangeRouting,
  CreateChangeRequestInput,
  CreateDelegationInput,
  DecideApprovalInput,
  DecideResult,
  Delegation,
  Delegations,
  MyReviews,
  PendingChangePreview,
  PlanChangesInput,
  RequestRiskAcceptanceInput,
  ReviewApprover,
  ReviewBucketValue,
  ReviewItem,
  ReviewType,
  ScopeChangesInput,
  SentReview,
  SetSponsorInput,
  SubmitChangeResult,
  UpdateChangeRequestInput,
} from '../schemas/flow-approvals';

export interface MyReviewsQuery {
  type?: ReviewType;
  projectId?: string;
}

export interface ReviewsPageQuery extends MyReviewsQuery {
  cursor?: string;
  /** 1 to 100, 25 by default. */
  limit?: number;
}

export interface ListChangeRequestsQuery {
  projectId?: string;
  status?: ChangeRequestStatusValue;
  search?: string;
  cursor?: string;
  /** 1 to 100, 25 by default. */
  limit?: number;
}

export interface ListBaselinesQuery {
  projectId?: string;
  cursor?: string;
  limit?: number;
}

export interface CompareBaselinesQuery {
  /** The project whose latest baseline is compared, when `from` is not given. */
  projectId?: string;
  /** A baseline id. */
  from?: string;
  /** A baseline id, or `current` (the default) for the live plan. */
  to?: string;
}

const approvalsBase = '/approvals';
const changesBase = '/project-changes';
const baselinesBase = '/project-baselines';
const raidBase = '/project-raid';

export function createFlowApprovalsApi(api: ClientApi) {
  return {
    // My reviews ---------------------------------------------------------
    /** The caller's open reviews in three groups (overdue, this week, later), with the per-type counts. */
    getMyReviews(params: MyReviewsQuery = {}): Promise<DataResponse<MyReviews>> {
      return api.get(`${approvalsBase}/mine${buildQueryString({ ...params })}`);
    },

    /** The number the sidebar badge shows: one cheap call. */
    getMyReviewsCount(): Promise<DataResponse<{ count: number; overdue: number }>> {
      return api.get(`${approvalsBase}/mine/count`);
    },

    /** Subjects the caller asked approval for that still wait for someone. */
    listSentReviews(params: ReviewsPageQuery = {}): Promise<ListResponse<SentReview>> {
      return api.get(`${approvalsBase}/sent${buildQueryString({ ...params })}`);
    },

    /** Reviews the caller answered, newest first. */
    listDoneReviews(params: ReviewsPageQuery = {}): Promise<ListResponse<ReviewItem>> {
      return api.get(`${approvalsBase}/done${buildQueryString({ ...params })}`);
    },

    /**
     * Approve, approve with conditions, decline or ask for more information.
     * Declining and setting conditions need a note. `id` is the review's id
     * (an approval row, or a pending time entry).
     */
    decideReview(id: string, input: DecideApprovalInput): Promise<DataResponse<DecideResult>> {
      return api.post(`${approvalsBase}/${id}/decide`, input);
    },

    // Delegation ---------------------------------------------------------
    listDelegations(): Promise<DataResponse<Delegations>> {
      return api.get(`${approvalsBase}/delegations`);
    },

    createDelegation(input: CreateDelegationInput): Promise<DataResponse<Delegation>> {
      return api.post(`${approvalsBase}/delegations`, input);
    },

    deleteDelegation(id: string): Promise<void> {
      return api.delete(`${approvalsBase}/delegations/${id}`);
    },

    // Sponsor ------------------------------------------------------------
    /** Set the project sponsor, or clear it with `null` (the project manager then sponsors). */
    setProjectSponsor(projectId: string, input: SetSponsorInput): Promise<DataResponse<{ projectId: string; sponsorId: string | null }>> {
      return api.put(`${approvalsBase}/projects/${projectId}/sponsor`, input);
    },

    // Change requests ----------------------------------------------------
    listChangeRequests(params: ListChangeRequestsQuery = {}): Promise<ListResponse<ChangeRequest>> {
      return api.get(`${changesBase}${buildQueryString({ ...params })}`);
    },

    /** The change with its approvers, what it changes once approved, how it was routed and who can answer. */
    getChangeRequest(id: string): Promise<DataResponse<ChangeRequestDetail>> {
      return api.get(`${changesBase}/${id}`);
    },

    createChangeRequest(input: CreateChangeRequestInput): Promise<DataResponse<ChangeRequest>> {
      return api.post(changesBase, input);
    },

    /** Editing the impact of a submitted change sends it back to `assessing` and clears its approvals. */
    updateChangeRequest(id: string, input: UpdateChangeRequestInput): Promise<DataResponse<ChangeRequest>> {
      return api.patch(`${changesBase}/${id}`, input);
    },

    /** Only a draft or a withdrawn change can be deleted. */
    deleteChangeRequest(id: string): Promise<void> {
      return api.delete(`${changesBase}/${id}`);
    },

    submitChangeRequest(id: string): Promise<DataResponse<SubmitChangeResult>> {
      return api.post(`${changesBase}/${id}/submit`);
    },

    withdrawChangeRequest(id: string): Promise<DataResponse<ChangeRequest>> {
      return api.post(`${changesBase}/${id}/withdraw`);
    },

    /** The approval rules of a project (cost limit, schedule limit, change board), its sponsor and the warnings. */
    getChangeControl(projectId: string): Promise<DataResponse<ChangeControlResponse>> {
      return api.get(`${changesBase}/settings/${projectId}`);
    },

    setChangeControl(projectId: string, input: ChangeControlSettingsInput): Promise<DataResponse<ChangeControlResponse>> {
      return api.put(`${changesBase}/settings/${projectId}`, input);
    },

    // Baselines ----------------------------------------------------------
    listBaselines(params: ListBaselinesQuery = {}): Promise<ListResponse<Baseline>> {
      return api.get(`${baselinesBase}${buildQueryString({ ...params })}`);
    },

    getBaseline(id: string): Promise<DataResponse<Baseline>> {
      return api.get(`${baselinesBase}/${id}`);
    },

    /** Variance between a baseline and another one, or the live plan, with previews of pending changes. */
    compareBaselines(params: CompareBaselinesQuery): Promise<DataResponse<BaselineComparison>> {
      return api.get(`${baselinesBase}/compare${buildQueryString({ ...params })}`);
    },

    /** Sign off v1 from the current plan (the project manager's, once). */
    signOffBaseline(projectId: string): Promise<DataResponse<Baseline>> {
      return api.post(`${baselinesBase}/projects/${projectId}/initial`);
    },

    // Risk acceptance ----------------------------------------------------
    /** Put a risk (strategy accept, score 9 or more) to the sponsor. */
    requestRiskAcceptance(
      id: string,
      input: RequestRiskAcceptanceInput = {},
    ): Promise<DataResponse<{ item: unknown; approvers: ReviewApprover[] }>> {
      return api.post(`${raidBase}/${id}/request-acceptance`, input);
    },
  };
}
