/**
 * WeldCRM mobile data layer, backed by the first-party API (see `app-api.ts`
 * for how a path reaches the right worker).
 *
 * The surface mirrors the platform's WeldCRM:
 *
 *   people         GET/POST/PATCH/DELETE /api/people, /api/people/:id/companies
 *   companies      GET/POST/PATCH/DELETE /api/companies, /api/companies/:id/people
 *   leads          GET/POST /api/leads
 *   tasks          GET/POST/PATCH/DELETE /api/activities (type = 'task')
 *   activities     POST /api/activities (call, email, meeting, note)
 *   pipelines      GET /api/pipelines + /api/pipeline-stages
 *   deals          GET/POST /api/opportunities (customerId is a COMPANY id)
 *   dashboard      derived from the list endpoints' totals
 *   currency       GET /api/workspace-settings
 *
 * The API returns `{ data }` / `{ data, pagination }` envelopes and throws on
 * non-2xx. Every method here catches that and returns `{ success, data }` /
 * `{ success: false, error }` so screens never need a try/catch around a call.
 */

import type { ApiResponse } from '@weldsuite/mobile-ui/types';
import { appApiClient } from './app-api';
import {
  TASK_TO_ACTIVITY_STATUS,
  activityStatusToTaskStatus,
  resolveName,
  type LoggableActivityType,
  type TaskStatus,
} from '@/lib/crm';
import { DEFAULT_CURRENCY, resolveCurrency, sumInCurrency, toNumber } from '@/lib/money';

// ============================================================================
// Public types
// ============================================================================

/** One page of a cursor-paginated list. */
export interface Page<T> {
  items: T[];
  totalCount: number;
  hasMore: boolean;
  /** Pass back as `cursor` to load the next page. */
  cursor: string | null;
}

export interface CrmDashboardStats {
  totalPeople: number;
  totalCompanies: number;
  newLeads: number;
  /** Percentage of all leads that converted. */
  conversionRate: number;
  wonDeals: number;
  /** Sum of won deals in `currency`. */
  revenue: number;
  /** The workspace currency `revenue` is in. */
  currency: string;
  /** Won deals left out of `revenue` because they are in another currency. */
  revenueExcluded: number;
  /** True when there are more won deals than the pages that were read. */
  revenuePartial: boolean;
  /** How many won deals were read for `revenue`. */
  revenueDealsRead: number;
  /**
   * Period-over-period changes in percent. The API has no history to compare
   * against, so these stay undefined and the dashboard shows no trend.
   */
  peopleChange?: number;
  companiesChange?: number;
  leadsChange?: number;
  revenueChange?: number;
  conversionRateChange?: number;
}

export interface CrmActivity {
  id: string;
  text: string;
  /** ISO timestamp the activity was created. */
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
  status: TaskStatus;
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

export interface CreateCrmTaskRequest {
  title: string;
  description?: string;
  status?: TaskStatus;
  dueDate?: string;
}

export interface UpdateCrmTaskRequest {
  title?: string;
  description?: string;
  status?: TaskStatus;
  completed?: boolean;
  /** ISO date. The API cannot clear a due date once set (its update schema has no null). */
  dueDate?: string;
}

export interface PersonRecord {
  id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
  email: string;
  phone?: string;
  mobile?: string;
  status?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyRecord {
  id: string;
  name: string;
  industry?: string;
  website?: string;
  email: string;
  phone?: string;
  description?: string;
  status?: string;
  createdAt: string;
  updatedAt: string;
}

/** A company a person works at (from `GET /people/:id/companies`). */
export interface PersonCompany {
  linkId: string;
  companyId: string;
  name: string;
  industry?: string;
  role?: string;
  isPrimary: boolean;
}

/** A person who works at a company (from `GET /companies/:id/people`). */
export interface CompanyPerson {
  linkId: string;
  personId: string;
  name: string;
  email?: string;
  role?: string;
  isPrimary: boolean;
}

export interface PersonInput {
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  notes?: string;
  /** The company the person works at; becomes their primary company. */
  companyId?: string;
}

export interface CompanyInput {
  name?: string;
  industry?: string;
  website?: string;
  email?: string;
  phone?: string;
  description?: string;
}

export interface LeadInput {
  firstName?: string;
  lastName?: string;
  email: string;
  companyName?: string;
  phone?: string;
}

export interface ActivityInput {
  type: LoggableActivityType;
  subject: string;
  description?: string;
  /** The company the activity is about. */
  companyId?: string;
  /** The person the activity is about. */
  personId?: string;
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

export interface DealRecord {
  id: string;
  name: string;
  /** Decimal string as stored, e.g. "1250.00". */
  value?: string;
  currency?: string;
  stageId?: string;
  pipelineId?: string;
  /** The company the deal is with. */
  companyId?: string;
  expectedCloseDate?: string;
  probability?: number;
  createdAt: string;
  updatedAt: string;
}

export interface DealInput {
  name: string;
  companyId: string;
  amount?: number;
  currency?: string;
  stageId?: string;
  probability?: number;
  closeDate?: string;
  notes?: string;
  pipelineId?: string;
}

// ============================================================================
// Wire shapes (internal)
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
  title?: string | null;
  email?: string | null;
  directPhone?: string | null;
  mobilePhone?: string | null;
  status?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CompanyRow {
  id: string;
  name: string;
  displayName?: string | null;
  industry?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  description?: string | null;
  status?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PersonCompanyRow {
  id: string;
  companyId: string;
  role?: string | null;
  isPrimary: boolean;
  company: { id: string; displayName: string; name?: string | null; industry?: string | null };
}

interface CompanyPersonRow {
  id: string;
  personId: string;
  role?: string | null;
  isPrimary: boolean;
  person: { id: string; displayName: string; email?: string | null };
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
  dueDate?: string;
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
  currency?: string | null;
  stageId?: string | null;
  pipeline?: string | null;
  customerId?: string | null;
  closeDate?: string | null;
  probability?: number | null;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceSettingsRow {
  currency?: string | null;
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

function toPage<T, R>(res: ListEnvelope<R>, map: (row: R) => T): Page<T> {
  return {
    items: res.data.map(map),
    totalCount: res.pagination.totalCount,
    hasMore: res.pagination.hasMore,
    cursor: res.pagination.cursor,
  };
}

/** Build `?a=1&b=2`, leaving out empty values. */
function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') qs.append(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
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

function mapPerson(row: PersonRow): PersonRecord {
  return {
    id: row.id,
    name: resolveName(row),
    firstName: row.firstName ?? undefined,
    lastName: row.lastName ?? undefined,
    jobTitle: row.title ?? undefined,
    email: row.email ?? '',
    phone: row.directPhone ?? undefined,
    mobile: row.mobilePhone ?? undefined,
    status: row.status ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapCompany(row: CompanyRow): CompanyRecord {
  return {
    id: row.id,
    name: resolveName(row),
    industry: row.industry ?? undefined,
    website: row.website ?? undefined,
    email: row.email ?? '',
    phone: row.phone ?? undefined,
    description: row.description ?? undefined,
    status: row.status ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapDeal(row: OpportunityRow): DealRecord {
  return {
    id: row.id,
    name: row.name,
    value: row.amount ?? undefined,
    currency: row.currency ?? undefined,
    stageId: row.stageId ?? undefined,
    pipelineId: row.pipeline ?? undefined,
    companyId: row.customerId ?? undefined,
    expectedCloseDate: row.closeDate ?? undefined,
    probability: row.probability ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapLead(row: LeadRow): CrmLead {
  return {
    id: row.id,
    name:
      row.fullName ||
      [row.firstName, row.lastName].filter(Boolean).join(' ') ||
      row.companyName ||
      row.email ||
      '',
    email: row.email ?? '',
    phone: row.phone ?? undefined,
    company: row.companyName ?? undefined,
    status: row.status ?? 'new',
    source: row.source ?? undefined,
    score: row.score ?? undefined,
    createdAt: row.createdAt,
  };
}

/** Won deals are read in pages of 100; this caps a dashboard load at 1,000 of them. */
const WON_DEALS_PAGE_LIMIT = 100;
const WON_DEALS_MAX_PAGES = 10;

let workspaceCurrencyCache: string | null = null;

// ============================================================================
// API client
// ============================================================================

const api = {
  // ========== Workspace ==========
  /**
   * The workspace's default currency (Settings > General). A workspace that
   * never saved one uses EUR, which is also what a deal without a currency is.
   */
  async getWorkspaceCurrency(): Promise<string> {
    if (workspaceCurrencyCache) return workspaceCurrencyCache;
    try {
      const res = await appApiClient.get<DataEnvelope<WorkspaceSettingsRow | null>>('/workspace-settings');
      workspaceCurrencyCache = resolveCurrency(res.data?.currency);
      return workspaceCurrencyCache;
    } catch {
      return DEFAULT_CURRENCY;
    }
  },

  // ========== Dashboard ==========
  /**
   * The API has no CRM stats endpoint, so the counters come from the list
   * endpoints' totals. Revenue adds up the won deals that are in the workspace
   * currency, across every page up to 1,000 deals; deals in other currencies
   * are counted in `revenueExcluded` and never converted or added.
   */
  async getCrmDashboardStats(): Promise<ApiResponse<CrmDashboardStats>> {
    try {
      const [people, companies, leadsAll, leadsNew, leadsConverted, currency] = await Promise.all([
        appApiClient.get<ListEnvelope<unknown>>('/people?limit=1&inCrm=true'),
        appApiClient.get<ListEnvelope<unknown>>('/companies?limit=1'),
        appApiClient.get<ListEnvelope<unknown>>('/leads?limit=1'),
        appApiClient.get<ListEnvelope<unknown>>('/leads?limit=1&status=new'),
        appApiClient.get<ListEnvelope<unknown>>('/leads?limit=1&status=converted'),
        api.getWorkspaceCurrency(),
      ]);

      const wonDeals: OpportunityRow[] = [];
      let wonTotalCount = 0;
      let cursor: string | null = null;
      let revenuePartial = false;
      for (let pageIndex = 0; pageIndex < WON_DEALS_MAX_PAGES; pageIndex += 1) {
        const res: ListEnvelope<OpportunityRow> = await appApiClient.get<ListEnvelope<OpportunityRow>>(
          `/opportunities${query({ status: 'won', limit: WON_DEALS_PAGE_LIMIT, cursor })}`,
        );
        wonDeals.push(...res.data);
        wonTotalCount = res.pagination.totalCount;
        cursor = res.pagination.cursor;
        if (!res.pagination.hasMore || !cursor) break;
        if (pageIndex === WON_DEALS_MAX_PAGES - 1) revenuePartial = true;
      }

      const revenue = sumInCurrency(
        wonDeals.map((deal) => ({ amount: deal.amount, currency: deal.currency })),
        currency,
      );
      const totalLeads = leadsAll.pagination.totalCount;
      const converted = leadsConverted.pagination.totalCount;
      return ok({
        totalPeople: people.pagination.totalCount,
        totalCompanies: companies.pagination.totalCount,
        newLeads: leadsNew.pagination.totalCount,
        conversionRate: totalLeads > 0 ? Math.round((converted / totalLeads) * 100) : 0,
        wonDeals: wonTotalCount,
        revenue: revenue.total,
        currency,
        revenueExcluded: revenue.excluded,
        revenuePartial,
        revenueDealsRead: wonDeals.length,
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

  // ========== People ==========
  async getPeople(params?: {
    cursor?: string | null;
    limit?: number;
    search?: string;
    companyId?: string;
  }): Promise<ApiResponse<Page<PersonRecord>>> {
    try {
      // `inCrm=true` is what the platform's People grid passes: it leaves out
      // identities that only exist because they emailed or chatted with you.
      const res = await appApiClient.get<ListEnvelope<PersonRow>>(
        `/people${query({
          limit: params?.limit ?? 25,
          cursor: params?.cursor,
          search: params?.search?.trim(),
          companyId: params?.companyId,
          inCrm: true,
        })}`,
      );
      return ok(toPage(res, mapPerson));
    } catch (err) {
      return fail(err);
    }
  },

  async getPerson(id: string): Promise<ApiResponse<PersonRecord>> {
    try {
      const res = await appApiClient.get<DataEnvelope<PersonRow>>(`/people/${id}`);
      return ok(mapPerson(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async getPersonCompanies(id: string): Promise<ApiResponse<PersonCompany[]>> {
    try {
      const res = await appApiClient.get<DataEnvelope<PersonCompanyRow[]>>(`/people/${id}/companies`);
      return ok(
        res.data.map((row) => ({
          linkId: row.id,
          companyId: row.companyId,
          name: row.company.displayName || row.company.name || '',
          industry: row.company.industry ?? undefined,
          role: row.role ?? undefined,
          isPrimary: row.isPrimary,
        })),
      );
    } catch (err) {
      return fail(err);
    }
  },

  async createPerson(input: PersonInput): Promise<ApiResponse<{ id: string }>> {
    try {
      const res = await appApiClient.post<DataEnvelope<{ id: string }>>('/people', personPayload(input));
      return ok({ id: res.data.id });
    } catch (err) {
      return fail(err);
    }
  },

  async updatePerson(id: string, input: PersonInput): Promise<ApiResponse<PersonRecord>> {
    try {
      const res = await appApiClient.patch<DataEnvelope<PersonRow>>(`/people/${id}`, personPayload(input));
      return ok(mapPerson(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async deletePerson(id: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.delete(`/people/${id}`);
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  // ========== Companies ==========
  async getCompanies(params?: {
    cursor?: string | null;
    limit?: number;
    search?: string;
  }): Promise<ApiResponse<Page<CompanyRecord>>> {
    try {
      const res = await appApiClient.get<ListEnvelope<CompanyRow>>(
        `/companies${query({
          limit: params?.limit ?? 25,
          cursor: params?.cursor,
          search: params?.search?.trim(),
        })}`,
      );
      return ok(toPage(res, mapCompany));
    } catch (err) {
      return fail(err);
    }
  },

  async getCompany(id: string): Promise<ApiResponse<CompanyRecord>> {
    try {
      const res = await appApiClient.get<DataEnvelope<CompanyRow>>(`/companies/${id}`);
      return ok(mapCompany(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async getCompanyPeople(id: string): Promise<ApiResponse<CompanyPerson[]>> {
    try {
      const res = await appApiClient.get<DataEnvelope<CompanyPersonRow[]>>(`/companies/${id}/people`);
      return ok(
        res.data.map((row) => ({
          linkId: row.id,
          personId: row.personId,
          name: row.person.displayName,
          email: row.person.email ?? undefined,
          role: row.role ?? undefined,
          isPrimary: row.isPrimary,
        })),
      );
    } catch (err) {
      return fail(err);
    }
  },

  async getCompanyDeals(id: string): Promise<ApiResponse<DealRecord[]>> {
    try {
      const res = await appApiClient.get<ListEnvelope<OpportunityRow>>(
        `/opportunities${query({ customerId: id, limit: 50 })}`,
      );
      return ok(res.data.map(mapDeal));
    } catch (err) {
      return fail(err);
    }
  },

  async createCompany(input: CompanyInput): Promise<ApiResponse<{ id: string }>> {
    try {
      const res = await appApiClient.post<DataEnvelope<{ id: string }>>('/companies', companyPayload(input));
      return ok({ id: res.data.id });
    } catch (err) {
      return fail(err);
    }
  },

  async updateCompany(id: string, input: CompanyInput): Promise<ApiResponse<CompanyRecord>> {
    try {
      const res = await appApiClient.patch<DataEnvelope<CompanyRow>>(`/companies/${id}`, companyPayload(input));
      return ok(mapCompany(res.data));
    } catch (err) {
      return fail(err);
    }
  },

  async deleteCompany(id: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.delete(`/companies/${id}`);
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  // ========== Leads ==========
  async getCrmLeads(params?: {
    cursor?: string | null;
    limit?: number;
    status?: string;
    search?: string;
  }): Promise<ApiResponse<Page<CrmLead>>> {
    try {
      const res = await appApiClient.get<ListEnvelope<LeadRow>>(
        `/leads${query({
          limit: params?.limit ?? 25,
          cursor: params?.cursor,
          status: params?.status,
          search: params?.search?.trim(),
        })}`,
      );
      return ok(toPage(res, mapLead));
    } catch (err) {
      return fail(err);
    }
  },

  async createLead(input: LeadInput): Promise<ApiResponse<{ id: string }>> {
    try {
      const res = await appApiClient.post<DataEnvelope<{ id: string }>>('/leads', {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email.trim(),
        companyName: input.companyName,
        phone: input.phone,
        source: 'mobile',
      });
      return ok({ id: res.data.id });
    } catch (err) {
      return fail(err);
    }
  },

  // ========== Tasks (backed by /api/activities?type=task) ==========
  async getCrmTasks(params?: {
    cursor?: string | null;
    limit?: number;
    status?: TaskStatus;
    search?: string;
  }): Promise<ApiResponse<Page<CrmTask>>> {
    try {
      const res = await appApiClient.get<ListEnvelope<ActivityRow>>(
        `/activities${query({
          type: 'task',
          limit: params?.limit ?? 50,
          cursor: params?.cursor,
          status: params?.status ? TASK_TO_ACTIVITY_STATUS[params.status] : undefined,
          search: params?.search?.trim(),
        })}`,
      );
      return ok(toPage(res, mapActivityToTask));
    } catch (err) {
      return fail(err);
    }
  },

  async createCrmTask(data: CreateCrmTaskRequest): Promise<ApiResponse<CrmTask>> {
    try {
      const res = await appApiClient.post<DataEnvelope<{ id: string }>>('/activities', {
        type: 'task',
        subject: data.title.trim(),
        description: data.description,
        status: data.status ? TASK_TO_ACTIVITY_STATUS[data.status] : undefined,
        dueDate: data.dueDate,
      });
      // Create returns { id }: build the full task so the screen can insert it
      // into local state without a refetch.
      return ok({
        id: res.data.id,
        title: data.title.trim(),
        description: data.description,
        completed: data.status === 'done',
        status: data.status ?? 'todo',
        dueDate: data.dueDate,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      return fail(err);
    }
  },

  async updateCrmTask(id: string, data: UpdateCrmTaskRequest): Promise<ApiResponse<CrmTask>> {
    const payload: Record<string, unknown> = {};
    if (data.title !== undefined) payload.subject = data.title.trim();
    if (data.description !== undefined) payload.description = data.description;
    if (data.dueDate !== undefined) payload.dueDate = data.dueDate;
    if (data.status !== undefined) {
      payload.status = TASK_TO_ACTIVITY_STATUS[data.status];
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

  async deleteCrmTask(id: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.delete(`/activities/${id}`);
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  // ========== Activities ==========
  async logActivity(input: ActivityInput): Promise<ApiResponse<{ id: string }>> {
    try {
      const res = await appApiClient.post<DataEnvelope<{ id: string }>>('/activities', {
        type: input.type,
        subject: input.subject.trim(),
        description: input.description,
        status: 'completed',
        customerId: input.companyId,
        contactId: input.personId,
        personId: input.personId,
      });
      return ok({ id: res.data.id });
    } catch (err) {
      return fail(err);
    }
  },

  // ========== Pipelines & deals ==========
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

  async getDeals(params?: {
    cursor?: string | null;
    limit?: number;
    search?: string;
    pipelineId?: string;
  }): Promise<ApiResponse<Page<DealRecord>>> {
    try {
      // The server filters by `pipeline` (id); stage filtering happens on the
      // board, which already groups deals by stage.
      const res = await appApiClient.get<ListEnvelope<OpportunityRow>>(
        `/opportunities${query({
          limit: params?.limit ?? 100,
          cursor: params?.cursor,
          search: params?.search?.trim(),
          pipeline: params?.pipelineId,
        })}`,
      );
      return ok(toPage(res, mapDeal));
    } catch (err) {
      return fail(err);
    }
  },

  async createDeal(data: DealInput): Promise<ApiResponse<DealRecord>> {
    try {
      const res = await appApiClient.post<DataEnvelope<{ id: string }>>('/opportunities', {
        name: data.name.trim(),
        customerId: data.companyId,
        amount: data.amount,
        currency: data.currency,
        stageId: data.stageId,
        probability: data.probability,
        closeDate: data.closeDate,
        description: data.notes,
        pipeline: data.pipelineId,
      });
      const now = new Date().toISOString();
      // Create returns { id }: build the record for local state.
      return ok({
        id: res.data.id,
        name: data.name.trim(),
        value: data.amount !== undefined ? String(toNumber(data.amount)) : undefined,
        currency: data.currency,
        stageId: data.stageId,
        pipelineId: data.pipelineId,
        companyId: data.companyId,
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

/** Request body for a person create or update; empty fields are left out. */
export function personPayload(input: PersonInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (input.firstName !== undefined) payload.firstName = input.firstName.trim();
  if (input.lastName !== undefined) payload.lastName = input.lastName.trim();
  if (input.jobTitle !== undefined) payload.title = input.jobTitle.trim();
  if (input.email !== undefined) payload.email = input.email.trim();
  if (input.phone !== undefined) payload.directPhone = input.phone.trim();
  if (input.mobile !== undefined) payload.mobilePhone = input.mobile.trim();
  if (input.notes !== undefined) payload.notes = input.notes;
  if (input.companyId) {
    payload.companyIds = [input.companyId];
    payload.primaryCompanyId = input.companyId;
  }
  return payload;
}

/** Request body for a company create or update; empty fields are left out. */
export function companyPayload(input: CompanyInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (input.name !== undefined) payload.name = input.name.trim();
  if (input.industry !== undefined) payload.industry = input.industry.trim();
  if (input.website !== undefined) payload.website = input.website.trim();
  if (input.email !== undefined) payload.email = input.email.trim();
  if (input.phone !== undefined) payload.phone = input.phone.trim();
  if (input.description !== undefined) payload.description = input.description;
  return payload;
}

export { api };
export default api;
