/**
 * App-API WeldFlow client for capacity, project intake and the roadmap
 * (`/api/capacity`, `/api/project-requests`). Served by flow-api.
 *
 * Request and response shapes are the shared Zod schemas in
 * `../schemas/flow-portfolio`, which flow-api validates against.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  BookResourceRequestInput,
  CapacityResponse,
  ConvertProjectRequestInput,
  CreateBookingInput,
  CreateProjectRequestInput,
  CreateResourceRequestInput,
  FlowWorkspaceSettings,
  IntakeFunnel,
  MemberProfile,
  MemberSuggestion,
  ProjectRequest,
  ProjectRequestStatus,
  ResourceBooking,
  ResourceRequest,
  ResourceRequestStatus,
  RoadmapResponse,
  ScoreBreakdownLine,
  ScoreProjectRequestInput,
  SkillFit,
  UpdateBookingInput,
  UpdateFlowSettingsInput,
  UpdateMemberProfileInput,
  UpdateProjectRequestInput,
  UpdateResourceRequestInput,
} from '../schemas/flow-portfolio';

export type * from '../schemas/flow-portfolio';

export interface CapacityQuery {
  from?: string;
  to?: string;
  skill?: string;
  tentative?: boolean;
}

export interface ListBookingsQuery {
  memberId?: string;
  projectId?: string;
  requestId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export interface ListResourceRequestsQuery {
  projectId?: string;
  status?: ResourceRequestStatus;
  cursor?: string;
  limit?: number;
}

export interface ListProjectRequestsQuery {
  status?: ProjectRequestStatus;
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface RoadmapQuery {
  from?: string;
  to?: string;
  tentative?: boolean;
}

export interface ApprovalAnswer {
  id: string;
  approverId: string;
  roleLabel: string | null;
  step: number;
  decision: string;
  note: string | null;
  decidedAt: string | null;
}

export type ProjectRequestDetail = ProjectRequest & {
  breakdown: ScoreBreakdownLine[];
  approvals: ApprovalAnswer[];
  fit: SkillFit[];
  fitWindow: { from: string; to: string };
};

export interface SuggestionsResult {
  request: ResourceRequest;
  suggestions: MemberSuggestion[];
  totalFreeHoursPerWeek: number;
  truncated: boolean;
}

const capacityBase = '/capacity';
const requestsBase = '/project-requests';

export function createFlowPortfolioApi(api: ClientApi) {
  return {
    // Capacity -------------------------------------------------------------
    getCapacity(params: CapacityQuery = {}): Promise<DataResponse<CapacityResponse>> {
      return api.get(`${capacityBase}${buildQueryString({ ...params })}`);
    },

    listBookings(params: ListBookingsQuery = {}): Promise<ListResponse<ResourceBooking>> {
      return api.get(`${capacityBase}/bookings${buildQueryString({ ...params })}`);
    },
    createBooking(input: CreateBookingInput): Promise<DataResponse<ResourceBooking>> {
      return api.post(`${capacityBase}/bookings`, input);
    },
    updateBooking(id: string, input: UpdateBookingInput): Promise<DataResponse<ResourceBooking>> {
      return api.patch(`${capacityBase}/bookings/${id}`, input);
    },
    deleteBooking(id: string): Promise<void> {
      return api.delete(`${capacityBase}/bookings/${id}`);
    },

    listResourceRequests(params: ListResourceRequestsQuery = {}): Promise<ListResponse<ResourceRequest>> {
      return api.get(`${capacityBase}/requests${buildQueryString({ ...params })}`);
    },
    createResourceRequest(input: CreateResourceRequestInput): Promise<DataResponse<ResourceRequest>> {
      return api.post(`${capacityBase}/requests`, input);
    },
    updateResourceRequest(id: string, input: UpdateResourceRequestInput): Promise<DataResponse<ResourceRequest>> {
      return api.patch(`${capacityBase}/requests/${id}`, input);
    },
    deleteResourceRequest(id: string): Promise<void> {
      return api.delete(`${capacityBase}/requests/${id}`);
    },
    getSuggestions(id: string): Promise<DataResponse<SuggestionsResult>> {
      return api.get(`${capacityBase}/requests/${id}/suggestions`);
    },
    bookResourceRequest(
      id: string,
      input: BookResourceRequestInput,
    ): Promise<DataResponse<{ booking: ResourceBooking; request: ResourceRequest }>> {
      return api.post(`${capacityBase}/requests/${id}/book`, input);
    },

    listProfiles(): Promise<ListResponse<MemberProfile>> {
      return api.get(`${capacityBase}/profiles`);
    },
    getProfile(memberId: string): Promise<DataResponse<MemberProfile>> {
      return api.get(`${capacityBase}/profiles/${memberId}`);
    },
    saveProfile(memberId: string, input: UpdateMemberProfileInput): Promise<DataResponse<MemberProfile>> {
      return api.put(`${capacityBase}/profiles/${memberId}`, input);
    },

    // Intake ---------------------------------------------------------------
    listProjectRequests(params: ListProjectRequestsQuery = {}): Promise<ListResponse<ProjectRequest>> {
      return api.get(`${requestsBase}${buildQueryString({ ...params })}`);
    },
    getIntakeFunnel(): Promise<DataResponse<IntakeFunnel>> {
      return api.get(`${requestsBase}/funnel`);
    },
    getRoadmap(params: RoadmapQuery = {}): Promise<DataResponse<RoadmapResponse>> {
      return api.get(`${requestsBase}/roadmap${buildQueryString({ ...params })}`);
    },
    getProjectRequest(id: string): Promise<DataResponse<ProjectRequestDetail>> {
      return api.get(`${requestsBase}/${id}`);
    },
    createProjectRequest(input: CreateProjectRequestInput): Promise<DataResponse<ProjectRequest>> {
      return api.post(requestsBase, input);
    },
    updateProjectRequest(id: string, input: UpdateProjectRequestInput): Promise<DataResponse<ProjectRequest>> {
      return api.patch(`${requestsBase}/${id}`, input);
    },
    deleteProjectRequest(id: string): Promise<void> {
      return api.delete(`${requestsBase}/${id}`);
    },
    scoreProjectRequest(id: string, input: ScoreProjectRequestInput): Promise<DataResponse<ProjectRequest>> {
      return api.post(`${requestsBase}/${id}/score`, input);
    },
    submitProjectRequest(id: string): Promise<DataResponse<ProjectRequest>> {
      return api.post(`${requestsBase}/${id}/submit`, {});
    },
    convertProjectRequest(id: string, input: ConvertProjectRequestInput): Promise<DataResponse<ProjectRequest>> {
      return api.post(`${requestsBase}/${id}/convert`, input);
    },
    getIntakeSettings(): Promise<DataResponse<FlowWorkspaceSettings>> {
      return api.get(`${requestsBase}/settings`);
    },
    saveIntakeSettings(input: UpdateFlowSettingsInput): Promise<DataResponse<FlowWorkspaceSettings>> {
      return api.put(`${requestsBase}/settings`, input);
    },
  };
}
