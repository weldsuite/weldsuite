/**
 * WeldCRM mobile data layer — backed by the unified app-api.
 *
 * Formerly targeted `/v1/crm/*` on mobile-api-worker (routes that were never
 * mounted — every call 404'd). Now maps onto the canonical app-api CRM
 * surface:
 *
 *   customers      → GET  /api/people, /api/people/:id
 *   leads          → GET  /api/leads
 *   tasks          → GET/POST/PATCH /api/activities (type = 'task')
 *   pipelines      → GET  /api/pipelines + /api/pipeline-stages
 *   opportunities  → GET/POST /api/opportunities
 *   dashboard      → derived from the list endpoints' totalCounts
 *
 * app-api returns `{ data }` / `{ data, pagination }` envelopes and throws on
 * non-2xx. This module adapts those back to the legacy
 * `ApiResponse<T>` / `PaginatedResponse<T>` shapes (`{ success, data }`,
 * `data.items` + `data.meta.total`) so the screens keep working unchanged.
 */

import type { ApiResponse, PaginatedResponse } from '@weldsuite/mobile-ui/types';
import { appApiClient } from './app-api';

// ============================================================================
// CRM types (public surface consumed by screens — unchanged)
// ============================================================================

export interface CrmDashboardStats {
  totalCustomers: number;
  customersChange: number;
  newLeads: number;
  leadsChange: number;
  revenue: number;
  revenueChange: number;
  conversionRate: number;
  conversionRateChange: number;
}

export interface CrmActivity {
  id: string;
  text: string;
  time: string;
  type: string;
}

export interface CrmLead {
  id: string;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  status: string;
  source?: string;
  score?: number;
  createdAt: string;
}

export interface CrmTask {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  status: 'todo' | 'in-progress' | 'blocked' | 'done';
  assignee?: {
    id: string;
    name: string;
    avatarUrl?: string;
  };
  linkedCompany?: {
    id: string;
    name: string;
    color?: string;
  };
  dueDate?: string;
  createdAt: string;
}

export interface CrmNote {
  id: string;
  title: string;
  content: string;
  linkedTo?: {
    type: 'company' | 'contact';
    id: string;
    name: string;
    color?: string;
  };
  category: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCrmTaskRequest {
  title: string;
  description?: string;
  status?: string;
  dueDate?: string;
}

export interface UpdateCrmTaskRequest {
  title?: string;
  description?: string;
  status?: string;
  completed?: boolean;
  dueDate?: string;
}

// Customer record (backed by app-api /api/people)
export interface CustomerRecord {
  id: string;
  // B2C fields
  firstName?: string;
  lastName?: string;
  fullName?: string;
  // B2B fields
  companyName?: string;
  // Common fields
  email: string;
  phone?: string;
  mobile?: string;
  website?: string;
  status?: string;
  type?: string; // 'b2c' | 'b2b'
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineStage {
  id: string;
  name: string;
  color?: string;
  position: number;
  pipelineId: string;
}

export interface PipelineWithStages {
  id: string;
  name: string;
  stages: PipelineStage[];
}

export interface OpportunityRecord {
  id: string;
  name: string;
  value?: string;
  stageId?: string;
  pipelineId?: string;
  customerId?: string;
  expectedCloseDate?: string;
  probability?: number;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// app-api envelopes + row shapes (internal)
// ============================================================================

interface ListEnvelope<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

interface DataEnvelope<T> {
  data: T;
}

interface PersonRow {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  displayName?: string | null;
  email?: string | null;
  directPhone?: string | null;
  mobilePhone?: string | null;
  status?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LeadRow {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  status?: string | null;
  source?: string | null;
  score?: number | null;
  createdAt: string;
}

interface ActivityRow {
  id: string;
  type: string;
  subject: string;
  description?: string | null;
  status?: string | null;
  dueDate?: string | null;
  createdAt: string;
}

interface PipelineRow {
  id: string;
  name: string;
}

interface PipelineStageRow {
  id: string;
  name: string;
  color?: string | null;
  position: number;
  /** Stores the owning pipeline's id ('default' for the legacy default pipeline). */
  pipeline?: string | null;
}

interface OpportunityRow {
  id: string;
  name: string;
  amount?: string | null;
  stageId?: string | null;
  pipeline?: string | null;
  customerId?: string | null;
  closeDate?: string | null;
  probability?: number | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Adapters
// ============================================================================

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function fail<T>(err: unknown): ApiResponse<T> {
  return { success: false, error: err instanceof Error ? err.message : 'Request failed' };
}

function paginated<T>(items: T[], total: number, limit: number, page = 1): PaginatedResponse<T> {
  return { items, data: items, meta: { page, limit, total } };
}

/** Mobile task status → crm_activities status. */
const TASK_TO_ACTIVITY_STATUS: Record<string, string> = {
  todo: 'planned',
  'in-progress': 'in_progress',
  blocked: 'deferred',
  done: 'completed',
};

/** crm_activities status → mobile task status. */
function activityStatusToTaskStatus(status?: string | null): CrmTask['status'] {
  switch (status) {
    case 'in_progress':
      return 'in-progress';
    case 'completed':
      return 'done';
    case 'deferred':
    case 'cancelled':
      return 'blocked';
    default:
      return 'todo';
  }
}

function mapActivityToTask(row: ActivityRow): CrmTask {
  return {
    id: row.id,
    title: row.subject,
    description: row.description ?? undefined,
    completed: row.status === 'completed',
    status: activityStatusToTaskStatus(row.status),
    dueDate: row.dueDate ?? undefined,
    createdAt: row.createdAt,
  };
}

function mapPersonToCustomer(row: PersonRow): CustomerRecord {
  return {
    id: row.id,
    firstName: row.firstName ?? undefined,
    lastName: row.lastName ?? undefined,
    fullName: row.displayName ?? row.fullName ?? undefined,
    email: row.email ?? '',
    phone: row.directPhone ?? undefined,
    mobile: row.mobilePhone ?? undefined,
    status: row.status ?? undefined,
    type: 'b2c',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapOpportunity(row: OpportunityRow): OpportunityRecord {
  return {
    id: row.id,
    name: row.name,
    value: row.amount ?? undefined,
    stageId: row.stageId ?? undefined,
    pipelineId: row.pipeline ?? undefined,
    customerId: row.customerId ?? undefined,
    expectedCloseDate: row.closeDate ?? undefined,
    probability: row.probability ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ============================================================================
// API client
// ============================================================================

const api = {
  // ========== CRM Dashboard ==========
  /**
   * app-api has no CRM dashboard-stats endpoint; derive the counters from the
   * list endpoints' totalCounts. Change percentages need historical data we
   * don't have, so they are reported as 0.
   */
  async getCrmDashboardStats(): Promise<ApiResponse<CrmDashboardStats>> {
    try {
      const [people, leadsAll, leadsNew, leadsConverted, wonOpps] = await Promise.all([
        appApiClient.get<ListEnvelope<unknown>>('/people?limit=1'),
        appApiClient.get<ListEnvelope<unknown>>('/leads?limit=1'),
        appApiClient.get<ListEnvelope<unknown>>('/leads?limit=1&status=new'),
        appApiClient.get<ListEnvelope<unknown>>('/leads?limit=1&status=converted'),
        appApiClient.get<ListEnvelope<OpportunityRow>>('/opportunities?limit=100&status=won'),
      ]);
      const totalLeads = leadsAll.pagination.totalCount;
      const converted = leadsConverted.pagination.totalCount;
      const revenue = wonOpps.data.reduce((sum, opp) => {
        const amount = parseFloat(opp.amount ?? '0');
        return sum + (Number.isFinite(amount) ? amount : 0);
      }, 0);
      return ok({
        totalCustomers: people.pagination.totalCount,
        customersChange: 0,
        newLeads: leadsNew.pagination.totalCount,
        leadsChange: 0,
        revenue,
        revenueChange: 0,
        conversionRate: totalLeads > 0 ? Math.round((converted / totalLeads) * 100) : 0,
        conversionRateChange: 0,
      });
    } catch (err) {
      return fail(err);
    }
  },

  async getCrmRecentActivities(limit = 5): Promise<ApiResponse<CrmActivity[]>> {
    try {
      const res = await appApiClient.get<ListEnvelope<ActivityRow>>(`/activities?limit=${limit}`);
      return ok(
        res.data.map((row) => ({
          id: row.id,
          text: row.subject,
          time: row.createdAt,
          type: row.type,
        })),
      );
    } catch (err) {
      return fail(err);
    }
  },

  // ========== CRM Leads ==========
  async getCrmLeads(params?: {
    page?: number;
    limit?: number;
    filters?: { status?: string };
    search?: string;
  }): Promise<ApiResponse<PaginatedResponse<CrmLead>>> {
    const limit = params?.limit ?? 25;
    const qs = new URLSearchParams();
    qs.append('limit', String(limit));
    if (params?.filters?.status) qs.append('status', params.filters.status);
    if (params?.search) qs.append('search', params.search);
    try {
      const res = await appApiClient.get<ListEnvelope<LeadRow>>(`/leads?${qs.toString()}`);
      const items = res.data.map((row) => ({
        id: row.id,
        name:
          row.fullName ||
          [row.firstName, row.lastName].filter(Boolean).join(' ') ||
          row.companyName ||
          row.email ||
          'Lead',
        email: row.email ?? '',
        phone: row.phone ?? undefined,
        company: row.companyName ?? undefined,
        status: row.status ?? 'new',
        source: row.source ?? undefined,
        score: row.score ?? undefined,
        createdAt: row.createdAt,
      }));
      return ok(paginated(items, res.pagination.totalCount, limit, params?.page ?? 1));
    } catch (err) {
      return fail(err);
    }
  },

  // ========== CRM Tasks (backed by /api/activities?type=task) ==========
  async getCrmTasks(params?: {
    page?: number;
    limit?: number;
    status?: string;
    search?: string;
  }): Promise<ApiResponse<PaginatedResponse<CrmTask>>> {
    const limit = params?.limit ?? 50;
    const qs = new URLSearchParams();
    qs.append('type', 'task');
    qs.append('limit', String(limit));
    if (params?.status) {
      qs.append('status', TASK_TO_ACTIVITY_STATUS[params.status] ?? params.status);
    }
    if (params?.search) qs.append('search', params.search);
    try {
      const res = await appApiClient.get<ListEnvelope<ActivityRow>>(`/activities?${qs.toString()}`);
      return ok(
        paginated(res.data.map(mapActivityToTask), res.pagination.totalCount, limit, params?.page ?? 1),
      );
    } catch (err) {
      return fail(err);
    }
  },

  async createCrmTask(data: CreateCrmTaskRequest): Promise<ApiResponse<CrmTask>> {
    try {
      const res = await appApiClient.post<DataEnvelope<{ id: string }>>('/activities', {
        type: 'task',
        subject: data.title,
        description: data.description,
        status: data.status ? (TASK_TO_ACTIVITY_STATUS[data.status] ?? undefined) : undefined,
        dueDate: data.dueDate,
      });
      // Create returns { id } — synthesize the full task so the screen can
      // insert it into local state without a refetch.
      return ok({
        id: res.data.id,
        title: data.title,
        description: data.description,
        completed: data.status === 'done',
        status: (data.status as CrmTask['status']) ?? 'todo',
        dueDate: data.dueDate,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      return fail(err);
    }
  },

  async updateCrmTask(id: string, data: UpdateCrmTaskRequest): Promise<ApiResponse<CrmTask>> {
    const payload: Record<string, unknown> = {};
    if (data.title !== undefined) payload.subject = data.title;
    if (data.description !== undefined) payload.description = data.description;
    if (data.dueDate !== undefined) payload.dueDate = data.dueDate;
    if (data.status !== undefined) {
      payload.status = TASK_TO_ACTIVITY_STATUS[data.status] ?? data.status;
    } else if (data.completed !== undefined) {
      payload.status = data.completed ? 'completed' : 'planned';
    }
    try {
      await appApiClient.patch<DataEnvelope<{ id: string }>>(`/activities/${id}`, payload);
      const res = await appApiClient.get<DataEnvelope<ActivityRow>>(`/activities/${id}`);
      return ok(mapActivityToTask(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  // ========== CRM Customer Records (backed by /api/people) ==========
  async getCrmCustomerRecords(params?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
  }): Promise<ApiResponse<PaginatedResponse<CustomerRecord>>> {
    const limit = params?.limit ?? 25;
    const qs = new URLSearchParams();
    qs.append('limit', String(limit));
    if (params?.search) qs.append('search', params.search);
    if (params?.status) qs.append('status', params.status);
    try {
      const res = await appApiClient.get<ListEnvelope<PersonRow>>(`/people?${qs.toString()}`);
      return ok(
        paginated(
          res.data.map(mapPersonToCustomer),
          res.pagination.totalCount,
          limit,
          params?.page ?? 1,
        ),
      );
    } catch (err) {
      return fail(err);
    }
  },

  async getCustomerById(id: string): Promise<ApiResponse<CustomerRecord>> {
    try {
      const res = await appApiClient.get<DataEnvelope<PersonRow>>(`/people/${id}`);
      return ok(mapPersonToCustomer(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  // ========== CRM Pipelines & Opportunities ==========
  async getPipelines(): Promise<ApiResponse<PipelineWithStages[]>> {
    try {
      const [pipelinesRes, stagesRes] = await Promise.all([
        appApiClient.get<ListEnvelope<PipelineRow>>('/pipelines?limit=50'),
        appApiClient.get<ListEnvelope<PipelineStageRow>>('/pipeline-stages?limit=200'),
      ]);
      const pipelines = pipelinesRes.data.map((pipeline) => ({
        id: pipeline.id,
        name: pipeline.name,
        stages: stagesRes.data
          .filter((stage) => stage.pipeline === pipeline.id)
          .sort((a, b) => a.position - b.position)
          .map((stage) => ({
            id: stage.id,
            name: stage.name,
            color: stage.color ?? undefined,
            position: stage.position,
            pipelineId: stage.pipeline ?? pipeline.id,
          })),
      }));
      return ok(pipelines);
    } catch (err) {
      return fail(err);
    }
  },

  async getOpportunities(params?: {
    page?: number;
    limit?: number;
    search?: string;
    stageId?: string;
    pipelineId?: string;
  }): Promise<ApiResponse<PaginatedResponse<OpportunityRecord>>> {
    const limit = params?.limit ?? 25;
    const qs = new URLSearchParams();
    qs.append('limit', String(limit));
    if (params?.search) qs.append('search', params.search);
    // app-api filters by `stage` (name) / `pipeline` (id); stageId has no
    // server-side filter, so callers filter client-side (the kanban already
    // does). `pipelineId` maps to the `pipeline` query param.
    if (params?.pipelineId) qs.append('pipeline', params.pipelineId);
    try {
      const res = await appApiClient.get<ListEnvelope<OpportunityRow>>(
        `/opportunities?${qs.toString()}`,
      );
      let items = res.data.map(mapOpportunity);
      if (params?.stageId) items = items.filter((opp) => opp.stageId === params.stageId);
      return ok(paginated(items, res.pagination.totalCount, limit, params?.page ?? 1));
    } catch (err) {
      return fail(err);
    }
  },

  async createOpportunity(data: {
    name: string;
    customerId: string;
    amount?: number;
    stageId?: string;
    stage?: string;
    probability?: number;
    closeDate: string;
    notes?: string;
    pipelineId?: string;
  }): Promise<ApiResponse<OpportunityRecord>> {
    try {
      const res = await appApiClient.post<DataEnvelope<{ id: string }>>('/opportunities', {
        name: data.name,
        customerId: data.customerId,
        amount: data.amount,
        stageId: data.stageId,
        stage: data.stage,
        probability: data.probability,
        closeDate: data.closeDate,
        description: data.notes,
        pipeline: data.pipelineId,
      });
      const now = new Date().toISOString();
      // Create returns { id } — synthesize the record for local state.
      return ok({
        id: res.data.id,
        name: data.name,
        value: data.amount !== undefined ? String(data.amount) : undefined,
        stageId: data.stageId,
        pipelineId: data.pipelineId,
        customerId: data.customerId,
        expectedCloseDate: data.closeDate,
        probability: data.probability,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      return fail(err);
    }
  },
};

export { api };
export default api;
