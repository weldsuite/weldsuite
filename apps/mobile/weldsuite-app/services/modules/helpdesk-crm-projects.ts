/**
 * W1b module package P3 — helpdesk + CRM + projects surface of the legacy
 * weldsuite-app ApiService, re-implemented against the unified app-api.
 *
 * Every method preserves the legacy name, signature and screen-facing
 * `ApiResponse<T>` / `PaginatedResponse<T>` return shape (the old
 * mobile-api-worker `{ success, data }` contract) while calling app-api
 * (`/api/...`) underneath via the shared client from `../app-api`.
 *
 * Endpoint map (legacy mobile-api-worker /v1 → app-api /api):
 * - /v1/helpdesk/conversations*           → /api/conversations (list/get/PATCH)
 * - /v1/helpdesk/conversations/:id/messages → /api/helpdesk-weldagent/conversations/:id (read)
 *                                            + POST …/:id/messages (reply)
 * - /v1/helpdesk/tickets*                 → /api/tickets + /api/ticket-messages + /api/ticket-notes
 * - /v1/helpdesk/dashboard*               → /api/helpdesk-stats (+ /api/dashboard/activity)
 * - /v1/helpdesk/agents                   → /api/helpdesk-agents
 * - /v1/helpdesk/teams                    → /api/desk/teams
 * - /v1/helpdesk/contacts*, /v1/crm/contacts* → /api/helpdesk-contacts
 * - /v1/crm/dashboard/customers           → /api/people
 * - /v1/crm/customers                     → /api/people
 * - /v1/crm/dashboard/leads               → /api/leads
 * - /v1/crm/dashboard/tasks|notes         → /api/activities (type 'task' / 'note')
 * - /v1/crm/pipelines                     → /api/pipelines + /api/pipeline-stages
 * - /v1/crm/opportunities                 → /api/opportunities
 * - /v1/projects*                         → /api/projects, /api/tasks, /api/my-tasks,
 *                                           /api/project-members, /api/project-files,
 *                                           /api/time-entries, /api/project-documents,
 *                                           /api/goals, /api/whiteboards
 *
 * Pagination: app-api is cursor-paginated; screens do page-increment infinite
 * scroll. A per-endpoint cursor map translates `page` N>1 into the stored
 * cursor (reset whenever page 1 is requested).
 */

import type { ApiResponse, PaginatedResponse } from '@weldsuite/mobile-ui/types';

import { appApiClient } from '../app-api';

// ============================================================================
// Types (moved verbatim from services/api.ts so the facade can re-export them)
// ============================================================================

// ---- Helpdesk ----

export interface Ticket {
  id: string;
  // Backend returns 'number', but we also support 'ticketNumber' for compatibility
  number?: string;
  ticketNumber?: string;
  subject: string;
  // Backend returns 'customerName', but we also support 'customer'
  customer?: string;
  customerName?: string;
  customerEmail?: string;
  status: string;
  priority: string;
  assignee?: string;
  assigneeId?: string;
  assigneeName?: string;
  category?: string;
  messages?: number;
  hasNewMessage?: boolean;
  newMessageCount?: number;
  lastMessagePreview?: string;
  lastMessageTime?: string;
  createdAt: string;
  updatedAt?: string;
  lastReplyAt?: string;
  type?: string;
}

export interface TicketDetail extends Ticket {
  description: string;
  resolvedAt?: string;
  closedAt?: string;
  satisfactionRating?: number;
  messagesList: TicketMessage[];
}

export interface TicketMessage {
  id: string;
  message: string;
  userName?: string;
  contactName?: string;
  messageType: string;
  isInternal: boolean;
  createdAt: string;
}

export interface HelpdeskStats {
  totalTickets: number;
  todayTickets: number;
  weekTickets: number;
  monthTickets: number;
  openTickets: number;
  inProgressTickets: number;
  resolvedTickets: number;
  closedTickets: number;
  avgResponseTime: string;
  avgResolutionTime: string;
  satisfactionScore: number;
  totalContacts: number;
}

export interface RecentTicket {
  id: string;
  ticketNumber: string;
  subject: string;
  customer: string;
  status: string;
  priority: string;
  createdAt: string;
}

export interface RecentActivity {
  id: string;
  description: string;
  type: string;
  createdAt: string;
}

export interface HelpdeskDashboard {
  openTickets: number;
  waitingCustomer: number;
  myAssigned: number;
  resolvedToday: number;
  ticketsByPriority: {
    low: number;
    normal: number;
    high: number;
    urgent: number;
  };
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  assignedCount: number;
}

export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  fullName?: string;
  email: string;
  directPhone?: string;
  mobilePhone?: string;
  title?: string;
  department?: string;
  role?: string;
  isPrimary?: boolean;
  isDecisionMaker?: boolean;
  status: string;
  notes?: string;
  lastContactedAt?: string;
  lastActivityType?: string;
  customerId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TicketFilters {
  search?: string;
  status?: string;
  priority?: string;
  assignedTo?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface Conversation {
  id: string;
  subject: string;
  status: string;
  priority: string;
  channel: string;
  customerId?: string;
  customerName?: string;
  customerEmail?: string;
  contactId?: string;
  contactName?: string;
  assigneeId?: string;
  assigneeName?: string;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  snoozedUntil?: string;
  firstResponseAt?: string;
  closedAt?: string;
  tags?: string[];
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  // For list view - last message preview
  lastMessagePreview?: string;
  lastMessageTime?: string;
  messageCount?: number;
  unreadCount?: number;
}

export interface ConversationDetail extends Conversation {
  messages?: ConversationMessage[];
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  authorType: 'customer' | 'agent' | 'system';
  authorName: string;
  authorEmail?: string;
  // Legacy fields
  userId?: string;
  userName?: string;
  userEmail?: string;
  contactId?: string;
  contactName?: string;
  contactEmail?: string;
  content: string;
  htmlContent?: string;
  type: string;
  isInternal: boolean;
  isPublic: boolean;
  attachments?: string[];
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt?: string;
}

export interface ConversationFilters {
  search?: string;
  status?: string;
  priority?: string;
  channel?: string;
  assigneeId?: string;
  isRead?: boolean;
  isStarred?: boolean;
  isArchived?: boolean;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface ContactFilters {
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface CreateContactRequest {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  mobile?: string;
  company?: string;
  position?: string;
}

export interface UpdateContactRequest {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  company?: string;
  position?: string;
  active?: boolean;
}

export interface UpdateTicketStatusRequest {
  status: string;
}

export interface UpdateTicketPriorityRequest {
  priority: string;
}

export interface AssignTicketRequest {
  assignedToId?: string;
}

// ---- CRM ----

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

export interface CrmCustomer {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
  avatarUrl?: string;
  createdAt: string;
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

export interface CreateCrmNoteRequest {
  title: string;
  content: string;
  category?: string;
  companyId?: string;
  contactId?: string;
}

export interface UpdateCrmNoteRequest {
  title?: string;
  content?: string;
  category?: string;
}

// CRM mobile-api-worker interfaces (matches customers table schema)
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

// ---- Projects ----

export interface ProjectStats {
  totalProjects: number;
  activeProjects: number;
  completedProjects: number;
  planningProjects: number;
  overdueProjects: number;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  key?: string;
  status: 'planning' | 'active' | 'onhold' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  progress: number;
  startDate?: string;
  endDate?: string;
  teamCount: number;
  totalTasks: number;
  completedTasks: number;
  customer?: {
    id: string;
    name: string;
  };
  projectManager?: {
    id: string;
    name: string;
    avatarUrl?: string;
  };
  color: string;
  createdAt: string;
  updatedAt?: string;
}

export interface ProjectDetail extends Project {
  health?: string;
  actualStartDate?: string;
  actualEndDate?: string;
  budgetedHours?: number;
  actualHours?: number;
  budgetedAmount?: number;
  actualAmount?: number;
  openTasks: number;
  totalMilestones: number;
  completedMilestones: number;
  methodology?: string;
  isBillable: boolean;
  tags?: string[];
}

/**
 * Merged from the two duplicate `ProjectTask` declarations in the legacy
 * services/api.ts (they declaration-merged; conflicting members `progress` and
 * `createdAt` are kept optional so both write sites remain assignable).
 */
export interface ProjectTask {
  id: string;
  title: string;
  description?: string;
  key?: string;
  status: string;
  priority: string;
  progress?: number;
  type?: string;
  assigneeId?: string;
  assigneeName?: string;
  assigneeAvatar?: string;
  reporterId?: string;
  startDate?: string;
  dueDate?: string;
  completedDate?: string;
  estimatedHours?: number;
  actualHours?: number;
  storyPoints?: number;
  tags?: string[];
  labels?: string[];
  position?: number;
  parentTaskId?: string;
  sprintId?: string;
  milestoneId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectTaskWithProject extends ProjectTask {
  project: {
    id: string;
    name: string;
    key?: string;
    color: string;
  };
}

export interface ProjectTaskStats {
  totalTasks: number;
  todoTasks: number;
  inProgressTasks: number;
  reviewTasks: number;
  doneTasks: number;
  blockedTasks: number;
  overdueTasks: number;
}

export interface ProjectReports {
  statusBreakdown: {
    status: string;
    count: number;
  }[];
  completionRate: number;
  avgProgress: number;
  recentCompletedTasks: {
    id: string;
    title: string;
    projectName: string;
    completedDate: string;
  }[];
  totalBudgetedHours: number;
  totalActualHours: number;
  hoursVariance: number;
  healthSummary: {
    health: string;
    count: number;
  }[];
  topProjects: {
    id: string;
    name: string;
    progress: number;
    totalTasks: number;
    completedTasks: number;
  }[];
}

export interface ProjectMember {
  id: string;
  userId: string;
  role: string;
  isActive: boolean;
  joinedAt?: string;
  allocationPercentage?: number;
  hourlyRate?: number;
  user?: {
    id: string;
    name: string;
    email: string;
    avatar?: string;
  };
}

export interface ProjectFile {
  id: string;
  name: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  url: string;
  thumbnailUrl?: string;
  uploadedBy?: string;
  uploadedByName?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TimeEntry {
  id: string;
  projectId?: string;
  taskId?: string;
  taskTitle?: string;
  userId: string;
  userName?: string;
  userAvatar?: string;
  date: string;
  startTime?: string;
  endTime?: string;
  duration: number;
  description?: string;
  activity?: string;
  billable: boolean;
  rate?: number;
  cost?: number;
  status: string;
  approvedBy?: string;
  approvedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectDocument {
  id: string;
  title: string;
  content?: string;
  contentType: string;
  coverImage?: string;
  icon?: string;
  isPublished: boolean;
  publishedAt?: string;
  lastEditedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectGoalsData {
  id?: string;
  mission?: any;
  goals: any[];
  lastEditedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

// Workload types
export interface WorkloadTaskStats {
  total: number;
  completed: number;
  inProgress: number;
  todo: number;
  overdue: number;
}

export interface WorkloadMemberTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  estimatedHours: number;
  actualHours: number;
  dueDate?: string;
  startDate?: string;
}

export interface WorkloadMember {
  userId: string;
  name: string;
  email?: string;
  avatar?: string;
  initials: string;
  role: string;
  capacity: number;
  allocated: number;
  actual: number;
  status: 'available' | 'near-capacity' | 'overallocated';
  utilizationPercent: number;
  taskStats: WorkloadTaskStats;
  tasks: WorkloadMemberTask[];
}

export interface WorkloadOverview {
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  todoTasks: number;
  overdueTasks: number;
  totalEstimatedHours: number;
  totalActualHours: number;
  totalCapacity: number;
  totalAllocated: number;
  utilization: number;
  overallocatedCount: number;
}

export interface ProjectWorkloadData {
  projectId: string;
  projectName: string;
  overview: WorkloadOverview;
  members: WorkloadMember[];
}

export interface ProjectWhiteboard {
  id?: string;
  name: string;
  elements: unknown[];
  appState: Record<string, unknown>;
  version: number;
  lastEditedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  key?: string;
  priority?: string;
  startDate?: string;
  endDate?: string;
  color?: string;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  status?: string;
  priority?: string;
  progress?: number;
  startDate?: string;
  endDate?: string;
  color?: string;
}

// ============================================================================
// Shared adapters (local copies — the assembler may dedupe these into
// services/modules/shared.ts alongside P1's versions; they are private here)
// ============================================================================

/** app-api list envelope. */
interface AppApiListEnvelope<T> {
  data: T[];
  pagination?: { totalCount: number; hasMore: boolean; cursor: string | null };
}

/** Adapt a thrown app-api client error to the legacy `{ success:false }` shape. */
function toError(err: unknown): ApiResponse<never> {
  const e = err as { isApiError?: boolean; status?: number; message?: string } | null;
  if (e && typeof e === 'object' && e.isApiError === true) {
    return {
      success: false,
      error: { title: `api_error_${e.status ?? 0}`, message: e.message ?? 'Request failed' },
    };
  }
  return {
    success: false,
    error: { title: 'network_error', message: err instanceof Error ? err.message : 'Request failed' },
  };
}

function buildQuery(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  }
  const query = searchParams.toString();
  return query ? `?${query}` : '';
}

/**
 * Per-endpoint cursor store: app-api is cursor-paginated while screens do
 * page-increment infinite scroll. Page 1 resets the stored cursor; page N>1
 * sends the cursor captured from the previous page's response.
 */
const cursorStore = new Map<string, string>();

function cursorKey(path: string, query: Record<string, unknown>): string {
  const stable: Record<string, unknown> = {};
  for (const key of Object.keys(query).sort()) {
    if (query[key] !== undefined && query[key] !== null && query[key] !== '') stable[key] = query[key];
  }
  return `${path}|${JSON.stringify(stable)}`;
}

/** Raw cursor-aware list fetch. Throws on non-2xx (callers wrap with toError). */
async function listRaw<T>(
  path: string,
  query: Record<string, unknown>,
  page = 1,
  limit = 25,
): Promise<{ items: T[]; totalCount: number; hasMore: boolean }> {
  const key = cursorKey(path, query);
  const q: Record<string, unknown> = { ...query, limit };
  if (page > 1) {
    const cursor = cursorStore.get(key);
    if (cursor) q.cursor = cursor;
  } else {
    cursorStore.delete(key);
  }
  const res = await appApiClient.get<AppApiListEnvelope<T>>(`${path}${buildQuery(q)}`);
  const items = res.data ?? [];
  const totalCount = res.pagination?.totalCount ?? items.length;
  const hasMore = res.pagination?.hasMore ?? false;
  if (res.pagination?.cursor) {
    cursorStore.set(key, res.pagination.cursor);
  }
  return { items, totalCount, hasMore };
}

/**
 * Wrap items in the legacy paginated payload. Screens are split between
 * reading `.data`/`.items`, `.meta` and `.pagination` — emit all of them.
 */
function wrapList<T>(
  items: T[],
  totalCount: number,
  hasMore: boolean,
  page = 1,
  limit = 25,
): ApiResponse<PaginatedResponse<T>> {
  const totalPages = limit > 0 ? Math.max(1, Math.ceil(totalCount / limit)) : 1;
  const payload = {
    data: items,
    items,
    pagination: { page, pageSize: limit, totalCount, totalPages, hasMore },
    meta: { page, limit, total: totalCount, totalPages, hasNext: hasMore, hasPrev: page > 1 },
  };
  return { success: true, data: payload as unknown as PaginatedResponse<T> };
}

async function fetchPagedList<T>(
  path: string,
  query: Record<string, unknown>,
  page = 1,
  limit = 25,
): Promise<ApiResponse<PaginatedResponse<T>>> {
  try {
    const { items, totalCount, hasMore } = await listRaw<T>(path, query, page, limit);
    return wrapList(items, totalCount, hasMore, page, limit);
  } catch (err) {
    return toError(err);
  }
}

async function getSingle<T>(path: string): Promise<ApiResponse<T>> {
  try {
    const res = await appApiClient.get<{ data: T }>(path);
    return { success: true, data: res.data };
  } catch (err) {
    return toError(err);
  }
}

async function getArray<T>(path: string): Promise<ApiResponse<T[]>> {
  try {
    const res = await appApiClient.get<{ data: T[] }>(path);
    return { success: true, data: res.data ?? [] };
  } catch (err) {
    return toError(err);
  }
}

async function postSingle<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
  try {
    const res = await appApiClient.post<{ data: T }>(path, body);
    return { success: true, data: res.data };
  } catch (err) {
    return toError(err);
  }
}

async function patchSingle<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
  try {
    const res = await appApiClient.patch<{ data: T }>(path, body);
    return { success: true, data: res.data };
  } catch (err) {
    return toError(err);
  }
}

/** DELETE → 204; synthesize the legacy `{ success: boolean }` data payload. */
async function deleteToSuccess(path: string): Promise<ApiResponse<{ success: boolean }>> {
  try {
    await appApiClient.delete<unknown>(path);
    return { success: true, data: { success: true } };
  } catch (err) {
    return toError(err);
  }
}

// ---- CRM task/note ↔ activity mapping helpers ----

function activityToCrmTaskStatus(status?: string | null): CrmTask['status'] {
  switch (status) {
    case 'completed':
      return 'done';
    case 'in_progress':
      return 'in-progress';
    case 'deferred':
    case 'cancelled':
      return 'blocked';
    default:
      return 'todo';
  }
}

function crmTaskStatusToActivity(status?: string): string | undefined {
  switch (status) {
    case 'done':
      return 'completed';
    case 'in-progress':
      return 'in_progress';
    case 'blocked':
      return 'deferred';
    case 'todo':
      return 'planned';
    default:
      return status;
  }
}

function activityRowToCrmTask(row: any): CrmTask {
  return {
    id: row.id,
    title: row.subject ?? '',
    description: row.description ?? undefined,
    completed: row.status === 'completed',
    status: activityToCrmTaskStatus(row.status),
    dueDate: row.dueDate ?? undefined,
    createdAt: row.createdAt ?? '',
  };
}

function activityRowToCrmNote(row: any): CrmNote {
  const linkedTo = row.contactId
    ? { type: 'contact' as const, id: row.contactId, name: row.relatedToName ?? '' }
    : row.customerId
      ? { type: 'company' as const, id: row.customerId, name: row.relatedToName ?? '' }
      : undefined;
  return {
    id: row.id,
    title: row.subject ?? '',
    content: row.description ?? '',
    linkedTo,
    category: row.relatedTo ?? 'general',
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? row.createdAt ?? '',
  };
}

function personRowToCrmCustomer(row: any): CrmCustomer {
  const firstName = row.firstName ?? '';
  const lastName = row.lastName ?? '';
  return {
    id: row.id,
    firstName,
    lastName,
    fullName: row.fullName || [firstName, lastName].filter(Boolean).join(' ') || row.email || '',
    email: row.email ?? '',
    phone: row.phone ?? row.mobile ?? undefined,
    company: row.companyName ?? row.company ?? undefined,
    jobTitle: row.jobTitle ?? row.title ?? undefined,
    avatarUrl: row.avatarUrl ?? undefined,
    createdAt: row.createdAt ?? '',
  };
}

function ticketMessageRowToLegacy(row: any, isInternal: boolean): TicketMessage {
  return {
    id: row.id,
    message: row.content ?? row.message ?? '',
    userName: row.authorName ?? row.userName ?? undefined,
    contactName: row.contactName ?? undefined,
    messageType: row.messageType ?? (isInternal ? 'note' : 'reply'),
    isInternal,
    createdAt: row.createdAt ?? '',
  };
}

// ============================================================================
// Module methods
// ============================================================================

export const helpdeskCrmProjectsApi = {
  // ==========================================================================
  // HELPDESK — dashboard
  // ==========================================================================

  async getHelpdeskStats(): Promise<ApiResponse<HelpdeskStats>> {
    // TODO(phase-out): /api/helpdesk-stats only aggregates ticket counts by
    // status/priority; today/week/month buckets, response times, satisfaction
    // and contact totals have no app-api source yet — zeroed (legacy
    // /v1/helpdesk/dashboard/stats was never richer in practice; screens are
    // defensive).
    try {
      const res = await appApiClient.get<{ data: any }>('/helpdesk-stats');
      const s = res.data ?? {};
      const stats: HelpdeskStats = {
        totalTickets: s.totalTickets ?? 0,
        todayTickets: 0,
        weekTickets: 0,
        monthTickets: 0,
        openTickets: s.openTickets ?? 0,
        inProgressTickets: s.pendingTickets ?? 0,
        resolvedTickets: s.resolvedTickets ?? 0,
        closedTickets: s.closedTickets ?? 0,
        avgResponseTime: '—',
        avgResolutionTime: '—',
        satisfactionScore: 0,
        totalContacts: 0,
      };
      return { success: true, data: stats };
    } catch (err) {
      return toError(err);
    }
  },

  async getRecentTickets(limit: number = 5): Promise<ApiResponse<RecentTicket[]>> {
    try {
      const { items } = await listRaw<any>('/tickets', {}, 1, limit);
      const mapped: RecentTicket[] = items.map((row) => ({
        id: row.id,
        ticketNumber: row.number ?? row.ticketNumber ?? '',
        subject: row.subject ?? '',
        customer: row.customerName ?? row.customer ?? '',
        status: row.status ?? '',
        priority: row.priority ?? '',
        createdAt: row.createdAt ?? '',
      }));
      return { success: true, data: mapped };
    } catch (err) {
      return toError(err);
    }
  },

  async getRecentActivity(limit: number = 10): Promise<ApiResponse<RecentActivity[]>> {
    // TODO(phase-out): /api/dashboard/activity is the cross-module activity
    // feed; field names may differ from the legacy helpdesk-only feed
    // (screens render description/type defensively).
    try {
      const res = await appApiClient.get<{ data: any[] }>(`/dashboard/activity${buildQuery({ limit })}`);
      const mapped: RecentActivity[] = (res.data ?? []).map((row: any) => ({
        id: row.id ?? '',
        description: row.description ?? row.text ?? row.title ?? '',
        type: row.type ?? 'activity',
        createdAt: row.createdAt ?? row.time ?? '',
      }));
      return { success: true, data: mapped };
    } catch (err) {
      return toError(err);
    }
  },

  // ==========================================================================
  // HELPDESK — conversations
  // ==========================================================================

  async getConversations(filters?: ConversationFilters): Promise<ApiResponse<PaginatedResponse<Conversation>>> {
    const page = filters?.page ?? 1;
    const limit = filters?.limit ?? 25;
    try {
      // app-api /conversations supports status/assigneeId/search/cursor/limit.
      // priority/channel/isRead/isStarred/isArchived are not list filters —
      // filtered client-side below (minor delta: filtering happens per page).
      const { items, totalCount, hasMore } = await listRaw<Conversation>(
        '/conversations',
        { status: filters?.status, assigneeId: filters?.assigneeId, search: filters?.search },
        page,
        limit,
      );
      let filtered = items;
      if (filters?.priority) filtered = filtered.filter((c) => c.priority === filters.priority);
      if (filters?.channel) filtered = filtered.filter((c) => c.channel === filters.channel);
      if (filters?.isRead !== undefined) filtered = filtered.filter((c) => c.isRead === filters.isRead);
      if (filters?.isStarred !== undefined) filtered = filtered.filter((c) => c.isStarred === filters.isStarred);
      if (filters?.isArchived !== undefined) filtered = filtered.filter((c) => c.isArchived === filters.isArchived);
      return wrapList(filtered, totalCount, hasMore, page, limit);
    } catch (err) {
      return toError(err);
    }
  },

  async getConversation(id: string): Promise<ApiResponse<ConversationDetail>> {
    return getSingle<ConversationDetail>(`/conversations/${id}`);
  },

  async getConversationMessages(id: string): Promise<ApiResponse<{ items: ConversationMessage[]; meta: { page: number; limit: number; total: number; totalPages: number; hasNext: boolean; hasPrev: boolean } }>> {
    try {
      // /api/helpdesk-weldagent/conversations/:id returns the conversation plus
      // its full helpdesk_conversation_messages history — the only app-api
      // surface for v1 conversation messages today (welddesk-app precedent).
      const res = await appApiClient.get<{ data: { messages?: any[] } }>(
        `/helpdesk-weldagent/conversations/${id}`,
      );
      const items = (res.data?.messages ?? []) as ConversationMessage[];
      return {
        success: true,
        data: {
          items,
          meta: {
            page: 1,
            limit: items.length,
            total: items.length,
            totalPages: 1,
            hasNext: false,
            hasPrev: false,
          },
        },
      };
    } catch (err) {
      return toError(err);
    }
  },

  async sendConversationMessage(id: string, content: string, isInternal: boolean = false): Promise<ApiResponse<ConversationMessage>> {
    try {
      // TODO(phase-out): posts through the weldagent message endpoint, which
      // has no isInternal flag and stores authorName as "WeldAgent" (authorId
      // is still the real user). Swap to a dedicated agent-reply route once
      // the v1 helpdesk conversation surface is fully ported to app-api.
      void isInternal;
      const res = await appApiClient.post<{ data: any }>(
        `/helpdesk-weldagent/conversations/${id}/messages`,
        { content, role: 'assistant' },
      );
      return { success: true, data: res.data as ConversationMessage };
    } catch (err) {
      return toError(err);
    }
  },

  async updateConversationStatus(id: string, status: string): Promise<ApiResponse<Conversation>> {
    return patchSingle<Conversation>(`/conversations/${id}`, { status });
  },

  async updateConversationPriority(id: string, priority: string): Promise<ApiResponse<Conversation>> {
    return patchSingle<Conversation>(`/conversations/${id}`, { priority });
  },

  async assignConversation(id: string, assigneeId: string | null, assigneeName?: string): Promise<ApiResponse<Conversation>> {
    // assigneeName was denormalized by the legacy worker; app-api resolves it
    // server-side from assigneeId.
    void assigneeName;
    return patchSingle<Conversation>(`/conversations/${id}`, { assigneeId });
  },

  async getAgents(): Promise<ApiResponse<{ id: string; userId: string; name: string; email: string; role: string; availability: string }[]>> {
    return getArray<{ id: string; userId: string; name: string; email: string; role: string; availability: string }>('/helpdesk-agents');
  },

  async markConversationAsRead(id: string): Promise<ApiResponse<Conversation>> {
    return patchSingle<Conversation>(`/conversations/${id}`, { isRead: true, unreadCount: 0 });
  },

  async markConversationAsUnread(id: string): Promise<ApiResponse<Conversation>> {
    return patchSingle<Conversation>(`/conversations/${id}`, { isRead: false });
  },

  async starConversation(id: string): Promise<ApiResponse<Conversation>> {
    return patchSingle<Conversation>(`/conversations/${id}`, { isStarred: true });
  },

  async unstarConversation(id: string): Promise<ApiResponse<Conversation>> {
    return patchSingle<Conversation>(`/conversations/${id}`, { isStarred: false });
  },

  async archiveConversation(id: string): Promise<ApiResponse<Conversation>> {
    return patchSingle<Conversation>(`/conversations/${id}`, { isArchived: true });
  },

  async unarchiveConversation(id: string): Promise<ApiResponse<Conversation>> {
    return patchSingle<Conversation>(`/conversations/${id}`, { isArchived: false });
  },

  async snoozeConversation(id: string, until: string): Promise<ApiResponse<Conversation>> {
    return patchSingle<Conversation>(`/conversations/${id}`, { snoozedUntil: until });
  },

  async closeConversation(id: string): Promise<ApiResponse<Conversation>> {
    return patchSingle<Conversation>(`/conversations/${id}`, { status: 'closed' });
  },

  async reopenConversation(id: string): Promise<ApiResponse<Conversation>> {
    return patchSingle<Conversation>(`/conversations/${id}`, { status: 'open' });
  },

  // ==========================================================================
  // HELPDESK — tickets
  // ==========================================================================

  async getTickets(filters?: TicketFilters): Promise<ApiResponse<PaginatedResponse<Ticket>>> {
    const page = filters?.page ?? 1;
    const limit = filters?.limit ?? 25;
    // app-api /tickets supports status/priority/assigneeId/search/cursor/limit;
    // sortBy/sortOrder are dropped (fixed createdAt desc ordering).
    return fetchPagedList<Ticket>(
      '/tickets',
      {
        search: filters?.search,
        status: filters?.status,
        priority: filters?.priority,
        assigneeId: filters?.assignedTo,
      },
      page,
      limit,
    );
  },

  async getTicket(id: string): Promise<ApiResponse<TicketDetail>> {
    try {
      // Legacy /v1 embedded messagesList in the ticket response; app-api splits
      // messages and internal notes into their own resources — compose here.
      const [ticketRes, messagesRes, notesRes] = await Promise.all([
        appApiClient.get<{ data: any }>(`/tickets/${id}`),
        appApiClient
          .get<AppApiListEnvelope<any>>(`/ticket-messages${buildQuery({ ticketId: id, limit: 100 })}`)
          .catch(() => ({ data: [] as any[] })),
        appApiClient
          .get<AppApiListEnvelope<any>>(`/ticket-notes${buildQuery({ ticketId: id, limit: 100 })}`)
          .catch(() => ({ data: [] as any[] })),
      ]);
      const messages = (messagesRes.data ?? []).map((row: any) => ticketMessageRowToLegacy(row, false));
      const notes = (notesRes.data ?? []).map((row: any) => ticketMessageRowToLegacy(row, true));
      const messagesList = [...messages, ...notes].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      const detail: TicketDetail = {
        ...(ticketRes.data as TicketDetail),
        description: ticketRes.data?.description ?? '',
        messagesList,
      };
      return { success: true, data: detail };
    } catch (err) {
      return toError(err);
    }
  },

  async getTicketStats(): Promise<ApiResponse<any>> {
    return getSingle<any>('/helpdesk-stats');
  },

  async updateTicketStatus(id: string, status: string): Promise<ApiResponse<Ticket>> {
    return patchSingle<Ticket>(`/tickets/${id}`, { status });
  },

  async updateTicketPriority(id: string, priority: string): Promise<ApiResponse<Ticket>> {
    return patchSingle<Ticket>(`/tickets/${id}`, { priority });
  },

  async assignTicket(id: string, assignedToId?: string): Promise<ApiResponse<Ticket>> {
    return patchSingle<Ticket>(`/tickets/${id}`, { assigneeId: assignedToId ?? null });
  },

  async createTicket(data: {
    subject: string;
    description?: string;
    priority?: string;
    customerId?: string;
    contactName?: string;
    contactEmail?: string;
    customerName?: string;
    customerEmail?: string;
  }): Promise<ApiResponse<TicketDetail>> {
    try {
      // app-api's createTicketSchema requires customerName + customerEmail and
      // uses the low/medium/high/urgent priority enum — adapt the looser
      // mobile payload (which may omit both and send 'normal').
      const customerEmail: string =
        data.customerEmail || data.contactEmail || 'unknown@customer.weldsuite.org';
      const customerName: string =
        data.customerName || data.contactName || customerEmail.split('@')[0] || 'Unknown';
      const priority = data.priority === 'normal' ? 'medium' : data.priority;
      const res = await appApiClient.post<{ data: any }>('/tickets', {
        subject: data.subject,
        description: data.description,
        customerId: data.customerId,
        customerEmail,
        customerName,
        ...(priority ? { priority } : {}),
      });
      const detail: TicketDetail = {
        ...(res.data as TicketDetail),
        description: res.data?.description ?? data.description ?? '',
        messagesList: res.data?.messagesList ?? [],
      };
      return { success: true, data: detail };
    } catch (err) {
      return toError(err);
    }
  },

  async replyToTicket(id: string, body: string, closeTicket?: boolean): Promise<ApiResponse<TicketMessage>> {
    try {
      const res = await appApiClient.post<{ data: any }>('/ticket-messages', {
        ticketId: id,
        content: body,
      });
      if (closeTicket) {
        await appApiClient.patch<{ data: any }>(`/tickets/${id}`, { status: 'closed' });
      }
      return { success: true, data: ticketMessageRowToLegacy(res.data ?? {}, false) };
    } catch (err) {
      return toError(err);
    }
  },

  async addInternalNote(ticketId: string, content: string): Promise<ApiResponse<TicketMessage>> {
    try {
      const res = await appApiClient.post<{ data: any }>('/ticket-notes', { ticketId, content });
      return { success: true, data: ticketMessageRowToLegacy(res.data ?? {}, true) };
    } catch (err) {
      return toError(err);
    }
  },

  async closeTicket(id: string): Promise<ApiResponse<TicketDetail>> {
    return patchSingle<TicketDetail>(`/tickets/${id}`, { status: 'closed' });
  },

  async reopenTicket(id: string): Promise<ApiResponse<TicketDetail>> {
    return patchSingle<TicketDetail>(`/tickets/${id}`, { status: 'open' });
  },

  async getHelpdeskDashboard(): Promise<ApiResponse<HelpdeskDashboard>> {
    // TODO(phase-out): /api/helpdesk-stats aggregates by status/priority only;
    // waitingCustomer≈pending, myAssigned/resolvedToday have no app-api source
    // yet and are zeroed. 'normal' priority bucket approximated as
    // total − urgent − high (app-api has no medium/low breakdown).
    try {
      const res = await appApiClient.get<{ data: any }>('/helpdesk-stats');
      const s = res.data ?? {};
      const urgent = s.urgentTickets ?? 0;
      const high = s.highPriorityTickets ?? 0;
      const total = s.totalTickets ?? 0;
      const dashboard: HelpdeskDashboard = {
        openTickets: s.openTickets ?? 0,
        waitingCustomer: s.pendingTickets ?? 0,
        myAssigned: 0,
        resolvedToday: 0,
        ticketsByPriority: {
          low: 0,
          normal: Math.max(0, total - urgent - high),
          high,
          urgent,
        },
      };
      return { success: true, data: dashboard };
    } catch (err) {
      return toError(err);
    }
  },

  async getTeamMembers(): Promise<ApiResponse<TeamMember[]>> {
    // TODO(phase-out): /api/desk/teams returns team rows; per-member
    // assignedCount has no app-api aggregate — defaulted to 0.
    try {
      const res = await appApiClient.get<{ data: any[] }>('/desk/teams');
      const mapped: TeamMember[] = (res.data ?? []).map((row: any) => ({
        id: row.id,
        name: row.name ?? '',
        email: row.email ?? '',
        assignedCount: row.assignedCount ?? row.memberCount ?? 0,
      }));
      return { success: true, data: mapped };
    } catch (err) {
      return toError(err);
    }
  },

  // ==========================================================================
  // HELPDESK — contacts (legacy /helpdesk/contacts + /crm/contacts)
  // ==========================================================================

  async getContacts(filters?: ContactFilters): Promise<ApiResponse<PaginatedResponse<Contact>>> {
    const page = filters?.page ?? 1;
    const limit = filters?.limit ?? 25;
    try {
      const { items, totalCount, hasMore } = await listRaw<any>(
        '/helpdesk-contacts',
        { search: filters?.search, status: filters?.status },
        page,
        limit,
      );
      // The contacts screens render fullName — synthesize when absent.
      const mapped = items.map((row) => ({
        ...row,
        fullName: row.fullName || [row.firstName, row.lastName].filter(Boolean).join(' ') || undefined,
      })) as Contact[];
      return wrapList<Contact>(mapped, totalCount, hasMore, page, limit);
    } catch (err) {
      return toError(err);
    }
  },

  async getContact(id: string): Promise<ApiResponse<Contact>> {
    return getSingle<Contact>(`/helpdesk-contacts/${id}`);
  },

  async getContactStats(): Promise<ApiResponse<any>> {
    // Legacy /v1/crm/contacts/stats was never mounted; derive the total from
    // the helpdesk-contacts list envelope.
    try {
      const { totalCount } = await listRaw<any>('/helpdesk-contacts', {}, 1, 1);
      return { success: true, data: { total: totalCount, totalContacts: totalCount } };
    } catch (err) {
      return toError(err);
    }
  },

  async createContact(contact: CreateContactRequest): Promise<ApiResponse<Contact>> {
    return postSingle<Contact>('/helpdesk-contacts', contact);
  },

  async updateContact(id: string, contact: UpdateContactRequest): Promise<ApiResponse<Contact>> {
    return patchSingle<Contact>(`/helpdesk-contacts/${id}`, contact);
  },

  // ==========================================================================
  // CRM
  // ==========================================================================

  async getCrmDashboardStats(): Promise<ApiResponse<CrmDashboardStats>> {
    // TODO(phase-out): no single app-api CRM dashboard endpoint. Totals are
    // composed from list envelopes; change/revenue/conversion metrics have no
    // source yet and are zeroed. (Legacy /v1/crm/* was never mounted — this
    // returned 404 in prod, so any data here is an improvement.)
    try {
      const [people, leads] = await Promise.all([
        listRaw<any>('/people', {}, 1, 1),
        listRaw<any>('/leads', {}, 1, 1),
      ]);
      const stats: CrmDashboardStats = {
        totalCustomers: people.totalCount,
        customersChange: 0,
        newLeads: leads.totalCount,
        leadsChange: 0,
        revenue: 0,
        revenueChange: 0,
        conversionRate: 0,
        conversionRateChange: 0,
      };
      return { success: true, data: stats };
    } catch (err) {
      return toError(err);
    }
  },

  async getCrmRecentActivities(limit = 5): Promise<ApiResponse<CrmActivity[]>> {
    try {
      const { items } = await listRaw<any>('/activities', {}, 1, limit);
      const mapped: CrmActivity[] = items.map((row) => ({
        id: row.id,
        text: row.subject ?? row.description ?? '',
        time: row.createdAt ?? '',
        type: row.type ?? 'activity',
      }));
      return { success: true, data: mapped };
    } catch (err) {
      return toError(err);
    }
  },

  async getCrmCustomers(params?: {
    page?: number;
    limit?: number;
    search?: string;
  }): Promise<ApiResponse<PaginatedResponse<CrmCustomer>>> {
    const page = params?.page ?? 1;
    const limit = params?.limit ?? 25;
    try {
      const { items, totalCount, hasMore } = await listRaw<any>(
        '/people',
        { search: params?.search },
        page,
        limit,
      );
      return wrapList<CrmCustomer>(items.map(personRowToCrmCustomer), totalCount, hasMore, page, limit);
    } catch (err) {
      return toError(err);
    }
  },

  async getCrmLeads(params?: {
    page?: number;
    limit?: number;
    status?: string;
    search?: string;
  }): Promise<ApiResponse<PaginatedResponse<CrmLead>>> {
    const page = params?.page ?? 1;
    const limit = params?.limit ?? 25;
    try {
      // Legacy filters[status] bracket param flattens to a plain status query.
      const { items, totalCount, hasMore } = await listRaw<any>(
        '/leads',
        { status: params?.status, search: params?.search },
        page,
        limit,
      );
      const mapped: CrmLead[] = items.map((row) => ({
        id: row.id,
        name:
          row.name ||
          row.fullName ||
          [row.firstName, row.lastName].filter(Boolean).join(' ') ||
          row.companyName ||
          row.email ||
          '',
        email: row.email ?? '',
        phone: row.phone ?? undefined,
        company: row.companyName ?? row.company ?? undefined,
        status: row.status ?? '',
        source: row.source ?? row.leadSource ?? undefined,
        score: row.score ?? undefined,
        createdAt: row.createdAt ?? '',
      }));
      return wrapList<CrmLead>(mapped, totalCount, hasMore, page, limit);
    } catch (err) {
      return toError(err);
    }
  },

  async getCrmTasks(params?: {
    page?: number;
    limit?: number;
    status?: string;
    search?: string;
  }): Promise<ApiResponse<PaginatedResponse<CrmTask>>> {
    const page = params?.page ?? 1;
    const limit = params?.limit ?? 25;
    try {
      // CRM tasks live in /api/activities with type 'task' on app-api.
      const { items, totalCount, hasMore } = await listRaw<any>(
        '/activities',
        { type: 'task', status: crmTaskStatusToActivity(params?.status), search: params?.search },
        page,
        limit,
      );
      return wrapList<CrmTask>(items.map(activityRowToCrmTask), totalCount, hasMore, page, limit);
    } catch (err) {
      return toError(err);
    }
  },

  async createCrmTask(data: CreateCrmTaskRequest): Promise<ApiResponse<CrmTask>> {
    try {
      const res = await appApiClient.post<{ data: any }>('/activities', {
        type: 'task',
        subject: data.title,
        description: data.description,
        dueDate: data.dueDate,
        ...(data.status ? { status: crmTaskStatusToActivity(data.status) } : {}),
      });
      return { success: true, data: activityRowToCrmTask(res.data ?? {}) };
    } catch (err) {
      return toError(err);
    }
  },

  async updateCrmTask(id: string, data: UpdateCrmTaskRequest): Promise<ApiResponse<CrmTask>> {
    try {
      const body: Record<string, unknown> = {};
      if (data.title !== undefined) body.subject = data.title;
      if (data.description !== undefined) body.description = data.description;
      if (data.dueDate !== undefined) body.dueDate = data.dueDate;
      if (data.completed !== undefined) {
        body.status = data.completed ? 'completed' : 'planned';
      } else if (data.status !== undefined) {
        body.status = crmTaskStatusToActivity(data.status);
      }
      const res = await appApiClient.patch<{ data: any }>(`/activities/${id}`, body);
      return { success: true, data: activityRowToCrmTask(res.data ?? {}) };
    } catch (err) {
      return toError(err);
    }
  },

  async getCrmNotes(params?: {
    page?: number;
    limit?: number;
    category?: string;
    search?: string;
  }): Promise<ApiResponse<PaginatedResponse<CrmNote>>> {
    const page = params?.page ?? 1;
    const limit = params?.limit ?? 25;
    try {
      // CRM notes live in /api/activities with type 'note'. The legacy
      // filters[category] param has no server-side equivalent — filtered
      // client-side against the relatedTo bucket.
      const { items, totalCount, hasMore } = await listRaw<any>(
        '/activities',
        { type: 'note', search: params?.search },
        page,
        limit,
      );
      let mapped = items.map(activityRowToCrmNote);
      if (params?.category) mapped = mapped.filter((n) => n.category === params.category);
      return wrapList<CrmNote>(mapped, totalCount, hasMore, page, limit);
    } catch (err) {
      return toError(err);
    }
  },

  async createCrmNote(data: CreateCrmNoteRequest): Promise<ApiResponse<CrmNote>> {
    try {
      const res = await appApiClient.post<{ data: any }>('/activities', {
        type: 'note',
        subject: data.title,
        description: data.content,
        ...(data.contactId ? { contactId: data.contactId } : {}),
        ...(data.companyId ? { customerId: data.companyId } : {}),
        ...(data.category ? { relatedTo: data.category } : {}),
      });
      return { success: true, data: activityRowToCrmNote(res.data ?? {}) };
    } catch (err) {
      return toError(err);
    }
  },

  async updateCrmNote(id: string, data: UpdateCrmNoteRequest): Promise<ApiResponse<CrmNote>> {
    try {
      const body: Record<string, unknown> = {};
      if (data.title !== undefined) body.subject = data.title;
      if (data.content !== undefined) body.description = data.content;
      if (data.category !== undefined) body.relatedTo = data.category;
      const res = await appApiClient.patch<{ data: any }>(`/activities/${id}`, body);
      return { success: true, data: activityRowToCrmNote(res.data ?? {}) };
    } catch (err) {
      return toError(err);
    }
  },

  async getCrmCustomerRecords(params?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
  }): Promise<ApiResponse<PaginatedResponse<CustomerRecord>>> {
    // TODO(phase-out): /api/people is the person surface; b2b company records
    // live in /api/companies. The legacy /v1/crm/customers mixed both — b2c
    // parity only for now.
    return fetchPagedList<CustomerRecord>(
      '/people',
      { search: params?.search, status: params?.status },
      params?.page ?? 1,
      params?.limit ?? 25,
    );
  },

  async getPipelines(): Promise<ApiResponse<PipelineWithStages[]>> {
    try {
      const [pipesRes, stagesRes] = await Promise.all([
        appApiClient.get<AppApiListEnvelope<any>>('/pipelines'),
        appApiClient.get<AppApiListEnvelope<any>>('/pipeline-stages?limit=200'),
      ]);
      const stagesByPipeline = new Map<string, PipelineStage[]>();
      for (const row of stagesRes.data ?? []) {
        const pipelineId = row.pipelineId ?? row.pipeline ?? '';
        const stage: PipelineStage = {
          id: row.id,
          name: row.name ?? '',
          color: row.color ?? undefined,
          position: row.position ?? row.displayOrder ?? 0,
          pipelineId,
        };
        const bucket = stagesByPipeline.get(pipelineId) ?? [];
        bucket.push(stage);
        stagesByPipeline.set(pipelineId, bucket);
      }
      const pipelines: PipelineWithStages[] = (pipesRes.data ?? []).map((row: any) => ({
        id: row.id,
        name: row.name ?? '',
        stages: (stagesByPipeline.get(row.id) ?? stagesByPipeline.get(row.name) ?? []).sort(
          (a, b) => a.position - b.position,
        ),
      }));
      return { success: true, data: pipelines };
    } catch (err) {
      return toError(err);
    }
  },

  async getOpportunities(params?: {
    page?: number;
    limit?: number;
    search?: string;
    stageId?: string;
    pipelineId?: string;
  }): Promise<ApiResponse<PaginatedResponse<OpportunityRecord>>> {
    return fetchPagedList<OpportunityRecord>(
      '/opportunities',
      { search: params?.search, stageId: params?.stageId, pipeline: params?.pipelineId },
      params?.page ?? 1,
      params?.limit ?? 25,
    );
  },

  async createOpportunity(data: {
    name: string;
    customerId: string;
    amount?: number;
    stageId?: string;
    stage?: string;
    probability?: number;
    closeDate: string; // ISO date string
    notes?: string;
    pipelineId?: string;
  }): Promise<ApiResponse<OpportunityRecord>> {
    return postSingle<OpportunityRecord>('/opportunities', {
      name: data.name,
      customerId: data.customerId,
      ...(data.amount !== undefined ? { amount: data.amount } : {}),
      ...(data.stageId ? { stageId: data.stageId } : {}),
      ...(data.stage ? { stage: data.stage } : {}),
      ...(data.probability !== undefined ? { probability: data.probability } : {}),
      closeDate: data.closeDate,
      ...(data.notes ? { description: data.notes } : {}),
      ...(data.pipelineId ? { pipeline: data.pipelineId } : {}),
    });
  },

  // ==========================================================================
  // PROJECTS (WeldFlow)
  // ==========================================================================

  async getProjectsStats(): Promise<ApiResponse<ProjectStats>> {
    // TODO(phase-out): no app-api projects dashboard endpoint — derived
    // client-side from the first 100 projects.
    try {
      const { items, totalCount } = await listRaw<any>('/projects', {}, 1, 100);
      const now = Date.now();
      const stats: ProjectStats = {
        totalProjects: totalCount,
        activeProjects: items.filter((p) => p.status === 'active').length,
        completedProjects: items.filter((p) => p.status === 'completed').length,
        planningProjects: items.filter((p) => p.status === 'planning').length,
        overdueProjects: items.filter(
          (p) =>
            p.endDate &&
            new Date(p.endDate).getTime() < now &&
            p.status !== 'completed' &&
            p.status !== 'cancelled',
        ).length,
      };
      return { success: true, data: stats };
    } catch (err) {
      return toError(err);
    }
  },

  async getProjects(params?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
  }): Promise<ApiResponse<PaginatedResponse<Project>>> {
    return fetchPagedList<Project>(
      '/projects',
      { search: params?.search, status: params?.status },
      params?.page ?? 1,
      params?.limit ?? 25,
    );
  },

  async getProject(id: string): Promise<ApiResponse<ProjectDetail>> {
    return getSingle<ProjectDetail>(`/projects/${id}`);
  },

  async getProjectTasks(projectId: string, params?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
  }): Promise<ApiResponse<PaginatedResponse<ProjectTask>>> {
    return fetchPagedList<ProjectTask>(
      '/tasks',
      { projectId, search: params?.search, status: params?.status },
      params?.page ?? 1,
      params?.limit ?? 25,
    );
  },

  async createProject(data: CreateProjectRequest): Promise<ApiResponse<Project>> {
    return postSingle<Project>('/projects', data);
  },

  async updateProject(id: string, data: UpdateProjectRequest): Promise<ApiResponse<Project>> {
    return patchSingle<Project>(`/projects/${id}`, data);
  },

  async getAllProjectTasks(params?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
    priority?: string;
    projectId?: string;
  }): Promise<ApiResponse<PaginatedResponse<ProjectTaskWithProject>>> {
    // TODO(phase-out): /api/my-tasks is the caller's cross-project task feed;
    // rows may not embed the { project } object the legacy shape carried —
    // screens should fall back to projectId. Verify once live.
    return fetchPagedList<ProjectTaskWithProject>(
      '/my-tasks',
      {
        search: params?.search,
        status: params?.status,
        priority: params?.priority,
        projectId: params?.projectId,
      },
      params?.page ?? 1,
      params?.limit ?? 25,
    );
  },

  async getProjectTaskStats(): Promise<ApiResponse<ProjectTaskStats>> {
    // TODO(phase-out): no app-api task-stats aggregate — derived client-side
    // from the first 100 tasks (totalTasks uses the true totalCount).
    try {
      const { items, totalCount } = await listRaw<any>('/tasks', {}, 1, 100);
      const now = Date.now();
      const byStatus = (s: string) => items.filter((t) => t.status === s).length;
      const stats: ProjectTaskStats = {
        totalTasks: totalCount,
        todoTasks: byStatus('todo'),
        inProgressTasks: byStatus('in_progress') + byStatus('in-progress'),
        reviewTasks: byStatus('review'),
        doneTasks: byStatus('done') + byStatus('completed'),
        blockedTasks: byStatus('blocked'),
        overdueTasks: items.filter(
          (t) =>
            t.dueDate &&
            new Date(t.dueDate).getTime() < now &&
            t.status !== 'done' &&
            t.status !== 'completed',
        ).length,
      };
      return { success: true, data: stats };
    } catch (err) {
      return toError(err);
    }
  },

  async getProjectReports(): Promise<ApiResponse<ProjectReports>> {
    // TODO(phase-out): /api/project-analytics/reports stores saved report
    // definitions, not the legacy aggregate — derived client-side from the
    // first 100 projects instead. recentCompletedTasks/hour totals have no
    // cheap source and are zeroed/empty.
    try {
      const { items } = await listRaw<any>('/projects', {}, 1, 100);
      const statusCounts = new Map<string, number>();
      const healthCounts = new Map<string, number>();
      let progressSum = 0;
      for (const p of items) {
        statusCounts.set(p.status ?? 'unknown', (statusCounts.get(p.status ?? 'unknown') ?? 0) + 1);
        if (p.health) healthCounts.set(p.health, (healthCounts.get(p.health) ?? 0) + 1);
        progressSum += p.progress ?? 0;
      }
      const completed = statusCounts.get('completed') ?? 0;
      const reports: ProjectReports = {
        statusBreakdown: Array.from(statusCounts.entries()).map(([status, count]) => ({ status, count })),
        completionRate: items.length > 0 ? Math.round((completed / items.length) * 100) : 0,
        avgProgress: items.length > 0 ? Math.round(progressSum / items.length) : 0,
        recentCompletedTasks: [],
        totalBudgetedHours: 0,
        totalActualHours: 0,
        hoursVariance: 0,
        healthSummary: Array.from(healthCounts.entries()).map(([health, count]) => ({ health, count })),
        topProjects: [...items]
          .sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0))
          .slice(0, 5)
          .map((p) => ({
            id: p.id,
            name: p.name ?? '',
            progress: p.progress ?? 0,
            totalTasks: p.totalTasks ?? 0,
            completedTasks: p.completedTasks ?? 0,
          })),
      };
      return { success: true, data: reports };
    } catch (err) {
      return toError(err);
    }
  },

  async getProjectMembers(projectId: string): Promise<ApiResponse<ProjectMember[]>> {
    return getArray<ProjectMember>(`/project-members${buildQuery({ projectId })}`);
  },

  async addProjectMember(projectId: string, data: { userId: string; role: string }): Promise<ApiResponse<ProjectMember>> {
    return postSingle<ProjectMember>('/project-members', { projectId, ...data });
  },

  async removeProjectMember(projectId: string, userId: string): Promise<ApiResponse<{ success: boolean }>> {
    return deleteToSuccess(
      `/project-members/by-user/${encodeURIComponent(projectId)}/${encodeURIComponent(userId)}`,
    );
  },

  async updateProjectMemberRole(projectId: string, userId: string, role: string): Promise<ApiResponse<ProjectMember>> {
    return patchSingle<ProjectMember>(
      `/project-members/by-user/${encodeURIComponent(projectId)}/${encodeURIComponent(userId)}`,
      { role },
    );
  },

  async getProjectFiles(projectId: string): Promise<ApiResponse<ProjectFile[]>> {
    return getArray<ProjectFile>(`/project-files${buildQuery({ projectId })}`);
  },

  async addProjectFile(projectId: string, data: {
    name: string;
    filename?: string;
    mimeType?: string;
    size?: number;
    url: string;
    thumbnailUrl?: string;
  }): Promise<ApiResponse<ProjectFile>> {
    return postSingle<ProjectFile>('/project-files', { projectId, ...data });
  },

  async uploadProjectFile(projectId: string, file: {
    uri: string;
    name: string;
    type: string;
  }): Promise<ApiResponse<ProjectFile>> {
    // TODO(phase-out): the legacy multipart POST /v1/projects/:id/files/upload
    // was never mounted (404 in prod). app-api uses a storage-upload-token
    // flow (upload to R2, then POST /api/project-files with the URL) — needs a
    // raw-fetch implementation outside the JSON client. Stubbed until the
    // orchestrator decides on the upload flow.
    void projectId;
    void file;
    return { success: false, error: 'not_supported' };
  },

  async deleteProjectFile(projectId: string, fileId: string): Promise<ApiResponse<{ success: boolean }>> {
    void projectId;
    return deleteToSuccess(`/project-files/${encodeURIComponent(fileId)}`);
  },

  async getProjectTasksList(projectId: string): Promise<ApiResponse<ProjectTask[]>> {
    try {
      const { items } = await listRaw<ProjectTask>('/tasks', { projectId }, 1, 100);
      return { success: true, data: items };
    } catch (err) {
      return toError(err);
    }
  },

  async getProjectWorkload(projectId: string): Promise<ApiResponse<ProjectWorkloadData>> {
    return getSingle<ProjectWorkloadData>(`/projects/${projectId}/workload`);
  },

  async createProjectTask(projectId: string, data: {
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    type?: string;
    assigneeId?: string;
    startDate?: string;
    dueDate?: string;
    estimatedHours?: number;
    storyPoints?: number;
    tags?: string[];
    labels?: string[];
    parentTaskId?: string;
    sprintId?: string;
    milestoneId?: string;
  }): Promise<ApiResponse<ProjectTask>> {
    return postSingle<ProjectTask>(`/tasks/projects/${encodeURIComponent(projectId)}`, data);
  },

  async updateProjectTask(projectId: string, taskId: string, data: {
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    type?: string;
    progress?: number;
    assigneeId?: string | null;
    startDate?: string | null;
    dueDate?: string | null;
    completedDate?: string | null;
    estimatedHours?: number | null;
    actualHours?: number | null;
    storyPoints?: number | null;
    tags?: string[];
    labels?: string[];
    position?: number;
  }): Promise<ApiResponse<ProjectTask>> {
    void projectId;
    return patchSingle<ProjectTask>(`/tasks/${encodeURIComponent(taskId)}`, data);
  },

  async deleteProjectTask(projectId: string, taskId: string): Promise<ApiResponse<{ success: boolean }>> {
    void projectId;
    return deleteToSuccess(`/tasks/${encodeURIComponent(taskId)}`);
  },

  async getProjectTimeEntries(projectId: string): Promise<ApiResponse<TimeEntry[]>> {
    try {
      const { items } = await listRaw<TimeEntry>('/time-entries', { projectId }, 1, 100);
      return { success: true, data: items };
    } catch (err) {
      return toError(err);
    }
  },

  async createTimeEntry(projectId: string, data: {
    taskId?: string;
    date: string;
    startTime?: string;
    endTime?: string;
    duration: number;
    description?: string;
    activity?: string;
    billable?: boolean;
    rate?: number;
  }): Promise<ApiResponse<TimeEntry>> {
    return postSingle<TimeEntry>('/time-entries', { projectId, ...data });
  },

  async updateTimeEntry(projectId: string, entryId: string, data: {
    taskId?: string | null;
    date?: string;
    startTime?: string | null;
    endTime?: string | null;
    duration?: number;
    description?: string;
    activity?: string;
    billable?: boolean;
    rate?: number | null;
  }): Promise<ApiResponse<TimeEntry>> {
    void projectId;
    return patchSingle<TimeEntry>(`/time-entries/${encodeURIComponent(entryId)}`, data);
  },

  async deleteTimeEntry(projectId: string, entryId: string): Promise<ApiResponse<{ success: boolean }>> {
    void projectId;
    return deleteToSuccess(`/time-entries/${encodeURIComponent(entryId)}`);
  },

  async getProjectDocuments(projectId: string): Promise<ApiResponse<ProjectDocument[]>> {
    // app-api project documents are `files` rows (entityType 'project',
    // fileType 'document') — map to the legacy ProjectDocument shape.
    try {
      const res = await appApiClient.get<{ data: any[] }>(
        `/project-documents/${encodeURIComponent(projectId)}`,
      );
      const mapped: ProjectDocument[] = (res.data ?? []).map((row: any) => ({
        id: row.id,
        title: row.fileName ?? row.originalName ?? row.title ?? '',
        contentType: row.mimeType ?? 'document',
        isPublished: false,
        createdAt: row.createdAt ?? undefined,
        updatedAt: row.updatedAt ?? undefined,
      }));
      return { success: true, data: mapped };
    } catch (err) {
      return toError(err);
    }
  },

  async saveProjectDocument(projectId: string, data: {
    title?: string;
    content?: string;
    contentType?: string;
    coverImage?: string;
    icon?: string;
  }): Promise<ApiResponse<ProjectDocument>> {
    // TODO(phase-out): POST /api/project-documents/:projectId only accepts a
    // document name (creates a .docx-backed file row); inline content is saved
    // through the docs editor surface, not here. Content/cover/icon are
    // dropped — acceptable for the dead legacy surface (404 in prod today).
    try {
      const res = await appApiClient.post<{ data: any }>(
        `/project-documents/${encodeURIComponent(projectId)}`,
        { name: data.title || 'Untitled document' },
      );
      const row = res.data ?? {};
      const doc: ProjectDocument = {
        id: row.id,
        title: row.fileName ?? data.title ?? '',
        content: data.content,
        contentType: row.mimeType ?? data.contentType ?? 'document',
        isPublished: false,
        createdAt: row.createdAt ?? undefined,
        updatedAt: row.updatedAt ?? undefined,
      };
      return { success: true, data: doc };
    } catch (err) {
      return toError(err);
    }
  },

  async deleteProjectDocument(projectId: string, documentId: string): Promise<ApiResponse<{ success: boolean }>> {
    // TODO(phase-out): /api/project-documents has no DELETE (file rows are
    // deleted through the files/welddrive surface). No app-api equivalent.
    void projectId;
    void documentId;
    return { success: false, error: 'not_supported' };
  },

  async getProjectGoals(projectId: string): Promise<ApiResponse<ProjectGoalsData>> {
    // app-api goals are individual rows; the legacy blob shape is synthesized.
    try {
      const res = await appApiClient.get<{ data: any }>(
        `/goals/by-project/${encodeURIComponent(projectId)}`,
      );
      const rows = Array.isArray(res.data) ? res.data : (res.data?.goals ?? []);
      return { success: true, data: { goals: rows } };
    } catch (err) {
      return toError(err);
    }
  },

  async saveProjectGoals(projectId: string, data: {
    mission?: any;
    goals?: any[];
  }): Promise<ApiResponse<ProjectGoalsData>> {
    // TODO(phase-out): the legacy endpoint upserted a single {mission, goals[]}
    // blob; app-api stores one row per goal (POST /api/goals). Only NEW goals
    // (no id) are created here — edits to existing goals and the mission text
    // have no app-api home yet. Dead surface in prod today (never mounted).
    try {
      const newGoals = (data.goals ?? []).filter((g) => !g?.id);
      for (const goal of newGoals) {
        await appApiClient.post<{ data: any }>('/goals', { ...goal, projectId });
      }
      const res = await appApiClient.get<{ data: any }>(
        `/goals/by-project/${encodeURIComponent(projectId)}`,
      );
      const rows = Array.isArray(res.data) ? res.data : (res.data?.goals ?? []);
      return { success: true, data: { mission: data.mission, goals: rows } };
    } catch (err) {
      return toError(err);
    }
  },

  async getProjectWhiteboard(projectId: string): Promise<ApiResponse<ProjectWhiteboard>> {
    try {
      const res = await appApiClient.get<AppApiListEnvelope<any>>(
        `/whiteboards${buildQuery({ projectId })}`,
      );
      const first = (res.data ?? [])[0];
      const board: ProjectWhiteboard = first
        ? {
            id: first.id,
            name: first.name ?? 'Whiteboard',
            elements: first.elements ?? [],
            appState: first.appState ?? {},
            version: first.version ?? 0,
            lastEditedBy: first.lastEditedBy ?? undefined,
            createdAt: first.createdAt ?? undefined,
            updatedAt: first.updatedAt ?? undefined,
          }
        : { name: 'Whiteboard', elements: [], appState: {}, version: 0 };
      return { success: true, data: board };
    } catch (err) {
      return toError(err);
    }
  },

  async saveProjectWhiteboard(projectId: string, data: {
    elements: unknown[];
    appState?: Record<string, unknown>;
  }): Promise<ApiResponse<ProjectWhiteboard>> {
    // Upsert: PATCH the project's first whiteboard if one exists, else create.
    try {
      const listRes = await appApiClient.get<AppApiListEnvelope<any>>(
        `/whiteboards${buildQuery({ projectId })}`,
      );
      const existing = (listRes.data ?? [])[0];
      const body = { elements: data.elements, appState: data.appState ?? {} };
      const res = existing
        ? await appApiClient.patch<{ data: any }>(`/whiteboards/${existing.id}`, body)
        : await appApiClient.post<{ data: any }>('/whiteboards', {
            projectId,
            name: 'Whiteboard',
            ...body,
          });
      const row = res.data ?? {};
      const board: ProjectWhiteboard = {
        id: row.id,
        name: row.name ?? 'Whiteboard',
        elements: row.elements ?? data.elements,
        appState: row.appState ?? data.appState ?? {},
        version: row.version ?? 0,
        lastEditedBy: row.lastEditedBy ?? undefined,
        createdAt: row.createdAt ?? undefined,
        updatedAt: row.updatedAt ?? undefined,
      };
      return { success: true, data: board };
    } catch (err) {
      return toError(err);
    }
  },
};

export default helpdeskCrmProjectsApi;
