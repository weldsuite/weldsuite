/**
 * App-API WeldFlow governance client (slice B): the decision log
 * (`/api/project-decisions`), deliverables (`/api/project-deliverables`), the
 * scope (`/api/project-scope`) and benefits (`/api/project-benefits`). Served
 * by flow-api. Shapes are the shared Zod schemas in
 * `../schemas/project-governance`.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  Benefit,
  BenefitDetail,
  BenefitMeasurement,
  BenefitStatus,
  CreateBenefitInput,
  CreateDecisionInput,
  CreateDeliverableInput,
  CreateMeasurementInput,
  Decision,
  DecisionDetail,
  DecideDecisionInput,
  DecisionStatus,
  Deliverable,
  DeliverableDetail,
  DeliverableStatus,
  GoalCardTargets,
  PutScopeInput,
  RejectDeliverableInput,
  RequestSignoffInput,
  Scope,
  SignoffApproval,
  SupersedeDecisionInput,
  UpdateBenefitInput,
  UpdateDecisionInput,
  UpdateDeliverableInput,
} from '../schemas/project-governance';

export type * from '../schemas/project-governance';

interface PageQuery {
  projectId?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface ListDecisionsQuery extends PageQuery {
  status?: DecisionStatus;
}
export interface ListDeliverablesQuery extends PageQuery {
  status?: DeliverableStatus;
}
export interface ListBenefitsQuery extends PageQuery {
  status?: BenefitStatus;
}

const decisions = '/project-decisions';
const deliverables = '/project-deliverables';
const scope = '/project-scope';
const benefits = '/project-benefits';

export function createProjectGovernanceApi(api: ClientApi) {
  return {
    // Decisions ------------------------------------------------------------
    listDecisions(params: ListDecisionsQuery = {}): Promise<ListResponse<Decision>> {
      return api.get(`${decisions}${buildQueryString({ ...params })}`);
    },
    getDecision(id: string): Promise<DataResponse<DecisionDetail>> {
      return api.get(`${decisions}/${id}`);
    },
    createDecision(input: CreateDecisionInput): Promise<DataResponse<Decision>> {
      return api.post(decisions, input);
    },
    updateDecision(id: string, input: UpdateDecisionInput): Promise<DataResponse<Decision>> {
      return api.patch(`${decisions}/${id}`, input);
    },
    deleteDecision(id: string): Promise<void> {
      return api.delete(`${decisions}/${id}`);
    },
    /** Record the decision: the project manager or the named decider. */
    decideDecision(id: string, input: DecideDecisionInput): Promise<DataResponse<Decision>> {
      return api.post(`${decisions}/${id}/decide`, input);
    },
    supersedeDecision(id: string, input: SupersedeDecisionInput): Promise<DataResponse<Decision>> {
      return api.post(`${decisions}/${id}/supersede`, input);
    },

    // Deliverables ---------------------------------------------------------
    listDeliverables(params: ListDeliverablesQuery = {}): Promise<ListResponse<Deliverable>> {
      return api.get(`${deliverables}${buildQueryString({ ...params })}`);
    },
    getDeliverable(id: string): Promise<DataResponse<DeliverableDetail>> {
      return api.get(`${deliverables}/${id}`);
    },
    createDeliverable(input: CreateDeliverableInput): Promise<DataResponse<Deliverable>> {
      return api.post(deliverables, input);
    },
    updateDeliverable(id: string, input: UpdateDeliverableInput): Promise<DataResponse<Deliverable>> {
      return api.patch(`${deliverables}/${id}`, input);
    },
    deleteDeliverable(id: string): Promise<void> {
      return api.delete(`${deliverables}/${id}`);
    },
    requestSignoff(
      id: string,
      input: RequestSignoffInput,
    ): Promise<DataResponse<{ deliverable: Deliverable; signoff: SignoffApproval[] }>> {
      return api.post(`${deliverables}/${id}/request-signoff`, input);
    },
    acceptDeliverable(id: string): Promise<DataResponse<Deliverable>> {
      return api.post(`${deliverables}/${id}/accept`, {});
    },
    rejectDeliverable(id: string, input: RejectDeliverableInput = {}): Promise<DataResponse<Deliverable>> {
      return api.post(`${deliverables}/${id}/reject`, input);
    },

    // Scope ----------------------------------------------------------------
    getScope(projectId: string): Promise<DataResponse<Scope>> {
      return api.get(`${scope}/${projectId}`);
    },
    putScope(projectId: string, input: PutScopeInput): Promise<DataResponse<Scope>> {
      return api.put(`${scope}/${projectId}`, input);
    },

    // Benefits -------------------------------------------------------------
    listBenefits(params: ListBenefitsQuery = {}): Promise<ListResponse<Benefit>> {
      return api.get(`${benefits}${buildQueryString({ ...params })}`);
    },
    getBenefit(id: string): Promise<DataResponse<BenefitDetail>> {
      return api.get(`${benefits}/${id}`);
    },
    createBenefit(input: CreateBenefitInput): Promise<DataResponse<Benefit>> {
      return api.post(benefits, input);
    },
    updateBenefit(id: string, input: UpdateBenefitInput): Promise<DataResponse<Benefit>> {
      return api.patch(`${benefits}/${id}`, input);
    },
    deleteBenefit(id: string): Promise<void> {
      return api.delete(`${benefits}/${id}`);
    },
    /** A manual value for a month. */
    createMeasurement(
      id: string,
      input: CreateMeasurementInput,
    ): Promise<DataResponse<{ measurement: BenefitMeasurement; benefit: Benefit }>> {
      return api.post(`${benefits}/${id}/measurements`, input);
    },
    /** Progress of the goal-card targets of a project. */
    getGoalTargets(projectId: string): Promise<DataResponse<GoalCardTargets[]>> {
      return api.get(`${benefits}/goal-targets${buildQueryString({ projectId })}`);
    },
  };
}
