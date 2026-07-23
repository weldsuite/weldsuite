
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

// =============================================================================
// app-api envelopes + legacy compatibility adapters
// =============================================================================
//
// This file is mid-migration (W5). Transport has moved to `app-api`, but the
// ~56 WeldDesk components that consume these hooks still read the legacy
// api-worker envelope (`{ success, data, pagination: { page, pageSize,
// totalPages, ... } }`). To keep every exported hook's *observable* contract
// identical while the consumers are migrated separately, the adapters below
// re-wrap the app-api response at the hook boundary.
//
// Once the consumers stop reading `.success` / `.totalPages`, drop these
// adapters and return the raw app-api envelope (see `useTickets` /
// `useHelpdeskReviews` below, which are already consumed that way).
//
// W5b closed the last gaps: every hook in this file now runs on `app-api`, and
// the legacy api-worker client is no longer imported here.

/** app-api single-resource envelope. */
interface AppApiSingle<T> {
  data: T;
}

/** app-api cursor-list envelope. */
interface AppApiList<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

/** Legacy api-worker single envelope, as the existing consumers expect it. */
interface LegacySingle<T> {
  success: true;
  data: T;
}

/** Legacy api-worker list envelope, as the existing consumers expect it. */
interface LegacyList<T> {
  success: true;
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
    hasMore: boolean;
    cursor: string | null;
  };
}

/** app-api hard-caps `limit` at 100. */
const APP_API_MAX_LIMIT = 100;
const DEFAULT_PAGE_SIZE = 25;

/**
 * Translate a legacy filter bag into an app-api query bag.
 *
 * `pageSize` → `limit` (capped at 100). `page` is dropped: app-api paginates
 * by opaque `cursor`, so offset jumps are not expressible. Callers that need
 * page 2+ must switch to cursor traversal (`pagination.cursor`).
 */
function toAppApiQuery(filters?: Record<string, any>): Record<string, any> {
  const qs: Record<string, any> = { ...(filters ?? {}) };
  const pageSize = qs.pageSize ?? qs.limit;
  delete qs.pageSize;
  delete qs.page;
  if (pageSize !== undefined) qs.limit = Math.min(Number(pageSize), APP_API_MAX_LIMIT);
  return qs;
}

function toLegacy<T>(res: AppApiSingle<T>): LegacySingle<T> {
  return { success: true, data: res.data };
}

function toLegacyList<T>(
  res: AppApiList<T>,
  filters?: { page?: number; pageSize?: number; limit?: number },
): LegacyList<T> {
  const page = filters?.page ?? 1;
  const pageSize = filters?.pageSize ?? filters?.limit ?? DEFAULT_PAGE_SIZE;
  const { totalCount, hasMore, cursor } = res.pagination;
  return {
    success: true,
    data: res.data,
    pagination: {
      page,
      pageSize,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / Math.max(1, pageSize))),
      hasMore,
      cursor,
    },
  };
}

// =============================================================================
// Query Keys
// =============================================================================

const helpdeskKeys = {
  all: ['helpdesk'] as const,

  // Tickets
  tickets: () => [...helpdeskKeys.all, 'tickets'] as const,
  ticketLists: () => [...helpdeskKeys.tickets(), 'list'] as const,
  ticketList: (filters?: Record<string, any>) => [...helpdeskKeys.ticketLists(), filters] as const,
  ticketDetails: () => [...helpdeskKeys.tickets(), 'detail'] as const,
  ticketDetail: (id: string) => [...helpdeskKeys.ticketDetails(), id] as const,
  ticketStats: (params?: Record<string, any>) => [...helpdeskKeys.tickets(), 'stats', params] as const,

  // Articles
  articles: () => [...helpdeskKeys.all, 'articles'] as const,
  articleLists: () => [...helpdeskKeys.articles(), 'list'] as const,
  articleList: (filters?: Record<string, any>) => [...helpdeskKeys.articleLists(), filters] as const,
  articleDetails: () => [...helpdeskKeys.articles(), 'detail'] as const,
  articleDetail: (id: string) => [...helpdeskKeys.articleDetails(), id] as const,

  // Agents
  agents: () => [...helpdeskKeys.all, 'agents'] as const,
  agentLists: () => [...helpdeskKeys.agents(), 'list'] as const,
  agentList: (filters?: Record<string, any>) => [...helpdeskKeys.agentLists(), filters] as const,
  agentDetails: () => [...helpdeskKeys.agents(), 'detail'] as const,
  agentDetail: (id: string) => [...helpdeskKeys.agentDetails(), id] as const,

  // Dashboard
  dashboardStats: () => [...helpdeskKeys.all, 'dashboard', 'stats'] as const,

  // Departments
  departments: () => [...helpdeskKeys.all, 'departments'] as const,
  departmentLists: () => [...helpdeskKeys.departments(), 'list'] as const,
  departmentList: (filters?: Record<string, any>) => [...helpdeskKeys.departmentLists(), filters] as const,
  departmentDetails: () => [...helpdeskKeys.departments(), 'detail'] as const,
  departmentDetail: (id: string) => [...helpdeskKeys.departmentDetails(), id] as const,

  // FAQs
  faqs: () => [...helpdeskKeys.all, 'faqs'] as const,
  faqLists: () => [...helpdeskKeys.faqs(), 'list'] as const,
  faqList: (filters?: Record<string, any>) => [...helpdeskKeys.faqLists(), filters] as const,

  // Canned Responses
  cannedResponses: () => [...helpdeskKeys.all, 'canned-responses'] as const,
  cannedResponseLists: () => [...helpdeskKeys.cannedResponses(), 'list'] as const,
  cannedResponseList: (filters?: Record<string, any>) => [...helpdeskKeys.cannedResponseLists(), filters] as const,
  cannedResponseDetails: () => [...helpdeskKeys.cannedResponses(), 'detail'] as const,
  cannedResponseDetail: (id: string) => [...helpdeskKeys.cannedResponseDetails(), id] as const,
  cannedResponseCategories: () => [...helpdeskKeys.cannedResponses(), 'categories'] as const,
  cannedResponseSearch: (q: string) => [...helpdeskKeys.cannedResponses(), 'search', q] as const,

  // Contacts
  contacts: () => [...helpdeskKeys.all, 'contacts'] as const,
  contactLists: () => [...helpdeskKeys.contacts(), 'list'] as const,
  contactList: (filters?: Record<string, any>) => [...helpdeskKeys.contactLists(), filters] as const,

  // Announcements
  announcements: () => [...helpdeskKeys.all, 'announcements'] as const,
  announcementLists: () => [...helpdeskKeys.announcements(), 'list'] as const,
  announcementList: (filters?: Record<string, any>) => [...helpdeskKeys.announcementLists(), filters] as const,

  // Changelog
  changelog: () => [...helpdeskKeys.all, 'changelog'] as const,
  changelogLists: () => [...helpdeskKeys.changelog(), 'list'] as const,
  changelogList: (filters?: Record<string, any>) => [...helpdeskKeys.changelogLists(), filters] as const,

  // News
  news: () => [...helpdeskKeys.all, 'news'] as const,
  newsLists: () => [...helpdeskKeys.news(), 'list'] as const,
  newsList: (filters?: Record<string, any>) => [...helpdeskKeys.newsLists(), filters] as const,

  // Feedback
  feedback: () => [...helpdeskKeys.all, 'feedback'] as const,
  feedbackLists: () => [...helpdeskKeys.feedback(), 'list'] as const,
  feedbackList: (filters?: Record<string, any>) => [...helpdeskKeys.feedbackLists(), filters] as const,

  // Reviews
  reviews: () => [...helpdeskKeys.all, 'reviews'] as const,
  reviewLists: () => [...helpdeskKeys.reviews(), 'list'] as const,
  reviewList: (filters?: Record<string, any>) => [...helpdeskKeys.reviewLists(), filters] as const,

  // Ticket Types
  ticketTypes: () => [...helpdeskKeys.all, 'ticket-types'] as const,
  ticketTypeLists: () => [...helpdeskKeys.ticketTypes(), 'list'] as const,
  ticketTypeDetail: (id: string) => [...helpdeskKeys.ticketTypes(), 'detail', id] as const,

  // Help Center
  helpcenter: () => [...helpdeskKeys.all, 'helpcenter'] as const,
  helpcenterSettings: () => [...helpdeskKeys.helpcenter(), 'settings'] as const,
  helpcenterDomains: () => [...helpdeskKeys.helpcenter(), 'domains'] as const,
};

// =============================================================================
// Helper to build query string
// =============================================================================

function buildQueryString(params: Record<string, any>): string {
  const queryParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      queryParams.set(key, String(value));
    }
  }
  const query = queryParams.toString();
  return query ? `?${query}` : '';
}

// =============================================================================
// Queries — Tickets
// =============================================================================

export function useTickets(filters?: {
  search?: string;
  status?: string;
  priority?: string;
  assigneeId?: string;
  departmentId?: string;
  ticketTypeId?: string;
  page?: number;
  pageSize?: number;
  cursor?: string;
}) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.ticketList(filters),
    queryFn: async () => {
      const client = await getClient();
      // Map legacy `pageSize` → app-api `limit`. `page` is ignored; callers
      // that need to paginate further should switch to cursor-based traversal.
      const qs: Record<string, unknown> = { ...(filters ?? {}) };
      if (qs.pageSize !== undefined) {
        qs.limit = qs.pageSize;
        delete qs.pageSize;
      }
      delete qs.page;
      const query = buildQueryString(qs);
      return client.get<{
        data: ApiTicket[];
        pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
      }>(`/tickets${query}`);
    },
  });
}

export function useTicket(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.ticketDetail(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ApiTicket }>(`/tickets/${id}`);
    },
    enabled: !!id && enabled,
  });
}

// =============================================================================
// Queries — Articles
// =============================================================================

export function useArticles(filters?: {
  search?: string;
  folderId?: string;
  status?: string;
  visibility?: string;
  limit?: number;
  cursor?: string;
}) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.articleList(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(filters || {});
      return client.get<{
        data: any[];
        pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
      }>(`/articles${query}`);
    },
  });
}

export function useArticle(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.articleDetail(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: any }>(`/articles/${id}`);
    },
    enabled: !!id && enabled,
  });
}

// =============================================================================
// Queries — Agents
// =============================================================================

export function useHelpdeskAgents(filters?: {
  search?: string;
  /** Not supported by app-api `GET /helpdesk-agents` — ignored server-side. */
  status?: string;
  departmentId?: string;
  page?: number;
  pageSize?: number;
}) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.agentList(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(toAppApiQuery(filters));
      const res = await client.get<AppApiList<any>>(`/helpdesk-agents${query}`);
      return toLegacyList(res, filters);
    },
  });
}

export function useHelpdeskAgent(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.agentDetail(id),
    queryFn: async () => {
      const client = await getClient();
      return toLegacy(await client.get<AppApiSingle<any>>(`/helpdesk-agents/${id}`));
    },
    enabled: !!id && enabled,
  });
}

// =============================================================================
// Queries — Departments
// =============================================================================

export function useDepartments(filters?: {
  search?: string;
  isActive?: boolean;
  page?: number;
  pageSize?: number;
}) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.departmentList(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(toAppApiQuery(filters));
      const res = await client.get<AppApiList<any>>(`/helpdesk-departments${query}`);
      return toLegacyList(res, filters);
    },
  });
}

export function useDepartment(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.departmentDetail(id),
    queryFn: async () => {
      const client = await getClient();
      return toLegacy(await client.get<AppApiSingle<any>>(`/helpdesk-departments/${id}`));
    },
    enabled: !!id && enabled,
  });
}

// =============================================================================
// Queries — Canned Responses
// =============================================================================

export function useCannedResponses(filters?: {
  search?: string;
  category?: string;
  page?: number;
  pageSize?: number;
}) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.cannedResponseList(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(toAppApiQuery(filters));
      const res = await client.get<AppApiList<any>>(`/canned-responses${query}`);
      return toLegacyList(res, filters);
    },
  });
}

/**
 * Scope-aware picker search. W5b added `/canned-responses/search` to app-api
 * (a port of the api-worker route) rather than reusing `GET /`, whose `search`
 * only matches name+subject and would silently narrow the picker's results.
 */
export function useSearchCannedResponses(q: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.cannedResponseSearch(q),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString({ q, limit: 20 });
      return toLegacy(await client.get<AppApiSingle<any[]>>(`/canned-responses/search${query}`));
    },
    enabled: q.length >= 1,
  });
}

// =============================================================================
// Queries — Contacts
// =============================================================================

export function useHelpdeskContacts(filters?: {
  search?: string;
  page?: number;
  pageSize?: number;
}) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.contactList(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(toAppApiQuery(filters));
      const res = await client.get<AppApiList<any>>(`/helpdesk-contacts${query}`);
      return toLegacyList(res, filters);
    },
  });
}

// =============================================================================
// Queries — Announcements
// =============================================================================

// NOTE: api-worker deleted its `/helpdesk/announcements` route while the
// platform kept calling it — this hook has been 404-ing. Pointing it at
// app-api's `/helpdesk-announcements` is a bug fix, not just a port.
export function useAnnouncements(filters?: {
  search?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.announcementList(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(toAppApiQuery(filters));
      const res = await client.get<AppApiList<any>>(`/helpdesk-announcements${query}`);
      return toLegacyList(res, filters);
    },
  });
}

// =============================================================================
// Queries — Changelog
// =============================================================================

// NOTE: api-worker deleted `/helpdesk/changelog` while the platform kept
// calling it, so this hook has been 404-ing. W5b added `/helpdesk-changelog`
// to app-api (read-only — no write hook exists), so pointing at it is a bug
// fix, not just a port.
//
// Unlike its siblings this hook drives a *numbered* pager
// (`app/welddesk/changelog` renders Prev/Next off `page`/`totalPages`), so it
// must re-add the `page` that `toAppApiQuery` strips: `/helpdesk-changelog`
// implements offset mode and `page` is what selects it. Left stripped, the
// server re-served page 1 for every page while `toLegacyList` echoed the
// requested number back — Next looked like it worked but changed nothing.
export function useChangelog(filters?: {
  search?: string;
  status?: string;
  type?: string;
  page?: number;
  pageSize?: number;
}) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.changelogList(filters),
    queryFn: async () => {
      const client = await getClient();
      // Default to 1 rather than omitting: an absent `page` would fall back to
      // cursor mode, whose meta carries no `totalPages` for the pager.
      const query = buildQueryString({ ...toAppApiQuery(filters), page: filters?.page ?? 1 });
      const res = await client.get<AppApiList<any>>(`/helpdesk-changelog${query}`);
      return toLegacyList(res, filters);
    },
  });
}

// =============================================================================
// Queries — News
// =============================================================================

export function useHelpdeskNews(filters?: {
  search?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.newsList(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(toAppApiQuery(filters));
      const res = await client.get<AppApiList<any>>(`/helpdesk-news${query}`);
      return toLegacyList(res, filters);
    },
  });
}

// =============================================================================
// Queries — Feedback
// =============================================================================

// NOTE: like `/helpdesk/announcements`, api-worker's `/helpdesk/feedback` was
// deleted out from under this hook — migrating it also un-breaks the page.
export function useHelpdeskFeedback(filters?: {
  search?: string;
  type?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.feedbackList(filters),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(toAppApiQuery(filters));
      const res = await client.get<AppApiList<any>>(`/helpdesk-feedback${query}`);
      return toLegacyList(res, filters);
    },
  });
}

// =============================================================================
// Queries — Reviews
// =============================================================================

export function useHelpdeskReviews(filters?: {
  search?: string;
  status?: string;
  page?: number;
  pageSize?: number;
  cursor?: string;
}) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.reviewList(filters),
    queryFn: async () => {
      const client = await getClient();
      const qs: Record<string, unknown> = { ...(filters ?? {}) };
      if (qs.pageSize !== undefined) {
        qs.limit = qs.pageSize;
        delete qs.pageSize;
      }
      delete qs.page;
      const query = buildQueryString(qs);
      return client.get<{
        data: any[];
        pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
      }>(`/helpdesk-reviews${query}`);
    },
  });
}

// =============================================================================
// Mutations — Tickets
// =============================================================================

/**
 * Create a ticket, optionally linked to the conversation it was raised from.
 *
 * W5b widened app-api's `POST /tickets` to accept `conversationId` (it was
 * absent from `createTicketSchema`, so Zod stripped it and the ticket was
 * orphaned) and to keep taking api-worker's `source` alias and `'normal'`
 * priority. `status: 'open'` is pinned here rather than in the route: the
 * route's default (DB `'new'`) is shared with the mobile callers, so the
 * legacy default is applied per-caller instead of changing it for everyone.
 *
 * `descriptionHtml` stays declared but unsent — api-worker's schema had no
 * such field either (it stripped it), and there is no column to store it, so
 * dropping it preserves the existing contract rather than silently regressing.
 */
export function useCreateTicket() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      subject: string;
      description: string;
      descriptionHtml?: string;
      priority?: string;
      source?: string;
      contactId?: string;
      customerName?: string;
      customerEmail?: string;
      assigneeId?: string;
      departmentId?: string;
      tags?: string[];
      conversationId?: string;
      ticketTypeId?: string;
      customFields?: Record<string, unknown>;
    }) => {
      const client = await getClient();
      const { descriptionHtml: _unsupported, ...payload } = data;
      return toLegacy(
        await client.post<AppApiSingle<any>>('/tickets', { ...payload, status: 'open' }),
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.tickets() });
      qc.invalidateQueries({ queryKey: helpdeskKeys.dashboardStats() });
      // A linked ticket writes a system message into its conversation.
      qc.invalidateQueries({ queryKey: [...helpdeskKeys.all, 'conversations'] });
    },
  });
}

// =============================================================================
// Mutations — Articles
// =============================================================================

export function useCreateArticle() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      title: string;
      content?: string;
      excerpt?: string;
      folderId?: string | null;
      status?: string;
      visibility?: string;
      tags?: string[];
    }) => {
      const client = await getClient();
      return client.post<{ data: { id: string } }>('/articles', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.articles() });
    },
  });
}

export function useUpdateArticle() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Record<string, any> }) => {
      const client = await getClient();
      return client.patch<{ data: { id: string } }>(`/articles/${id}`, data);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.articles() });
      qc.invalidateQueries({ queryKey: helpdeskKeys.articleDetail(variables.id) });
    },
  });
}

export function useDeleteArticle() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/articles/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.articles() });
    },
  });
}

// =============================================================================
// Mutations — Agents
// =============================================================================

// =============================================================================
// Mutations — Departments
// =============================================================================

export function useCreateDepartment() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name: string;
      description?: string;
      isActive?: boolean;
      sortOrder?: number;
      color?: string;
      icon?: string;
      email?: string;
    }) => {
      const client = await getClient();
      return toLegacy(await client.post<AppApiSingle<{ id: string }>>('/helpdesk-departments', data));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.departments() });
    },
  });
}

export function useUpdateDepartment() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Record<string, any> }) => {
      const client = await getClient();
      return toLegacy(await client.patch<AppApiSingle<{ id: string }>>(`/helpdesk-departments/${id}`, data));
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.departments() });
      qc.invalidateQueries({ queryKey: helpdeskKeys.departmentDetail(variables.id) });
    },
  });
}

// =============================================================================
// Mutations — Canned Responses
// =============================================================================

export function useCreateCannedResponse() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name: string;
      subject?: string;
      content: string;
      category?: string;
      scope?: 'personal' | 'team' | 'department' | 'global';
      agentId?: string;
      teamId?: string;
      departmentId?: string;
      shortcut?: string;
      keywords?: string[];
      actions?: Array<{ type: string; value: unknown }>;
      isActive?: boolean;
    }) => {
      const client = await getClient();
      return toLegacy(await client.post<AppApiSingle<{ id: string }>>('/canned-responses', data));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.cannedResponses() });
    },
  });
}

export function useUpdateCannedResponse() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...data }: {
      id: string;
      name?: string;
      subject?: string;
      content?: string;
      category?: string;
      scope?: 'personal' | 'team' | 'department' | 'global';
      shortcut?: string;
      keywords?: string[];
      actions?: Array<{ type: string; value: unknown }>;
      isActive?: boolean;
    }) => {
      const client = await getClient();
      return toLegacy(await client.patch<AppApiSingle<{ id: string }>>(`/canned-responses/${id}`, data));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.cannedResponses() });
    },
  });
}

export function useDeleteCannedResponse() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      // app-api answers 204 No Content; consumers still check `.success`.
      await client.delete<void>(`/canned-responses/${id}`);
      return { success: true as const };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.cannedResponses() });
    },
  });
}

/**
 * Renders `{{variables}}` server-side and bumps `usageCount`. W5b ported
 * `POST /canned-responses/:id/use` to app-api; the rendering must stay on the
 * server so the usage counter and the returned body cannot drift apart.
 */
export function useUseCannedResponse() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, variables }: { id: string; variables?: Record<string, unknown> }) => {
      const client = await getClient();
      return toLegacy(
        await client.post<
          AppApiSingle<{ content: string; subject: string | null; actions: Array<{ type: string; value: unknown }> }>
        >(`/canned-responses/${id}/use`, { variables: variables || {} }),
      );
    },
    onSuccess: () => {
      // Invalidate list to reflect updated usage counts
      qc.invalidateQueries({ queryKey: helpdeskKeys.cannedResponseLists() });
    },
  });
}

// =============================================================================
// Mutations — Contacts
// =============================================================================

/**
 * Fans out to the contact + that contact's conversations. W5b added the
 * `contactId` filter to app-api's conversations list — without it this would
 * silently have returned the workspace's *whole* conversation list as if it
 * belonged to this contact (unknown query params are ignored, not rejected).
 */
export function useHelpdeskContactDetailData(contactId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...helpdeskKeys.contacts(), 'detail', contactId],
    queryFn: async () => {
      const client = await getClient();
      const [contactResult, conversationsResult] = await Promise.all([
        client.get<AppApiSingle<any>>(`/helpdesk-contacts/${contactId}`).then(toLegacy),
        client
          .get<AppApiList<any>>(`/conversations?contactId=${contactId}&limit=50`)
          .then((res) => toLegacyList(res, { pageSize: 50 })),
      ]);
      return { contactResult, conversationsResult };
    },
    enabled: !!contactId && enabled,
  });
}

export function useUpdateHelpdeskContact() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: {
      id: string;
      data: {
        firstName?: string;
        lastName?: string;
        email?: string;
        phone?: string;
        notes?: string;
        avatarUrl?: string;
      };
    }) => {
      const client = await getClient();
      return toLegacy(await client.patch<AppApiSingle<{ id: string }>>(`/helpdesk-contacts/${id}`, data));
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.contacts() });
      qc.invalidateQueries({ queryKey: [...helpdeskKeys.contacts(), 'detail', variables.id] });
      qc.invalidateQueries({ queryKey: ['crm', 'contacts', 'detail', variables.id, 'full'] });
      // Conversation list JOINs with contacts — refetch to show updated name/email
      qc.invalidateQueries({ queryKey: [...helpdeskKeys.all, 'conversations'] });
    },
  });
}

// =============================================================================
// Mutations — Announcements
// =============================================================================

export function useCreateAnnouncement() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      title: string;
      content: string;
      htmlContent?: string;
      type?: string;
      status?: string;
      targetAudience?: string;
      publishedAt?: string;
      expiresAt?: string;
    }) => {
      const client = await getClient();
      return toLegacy(await client.post<AppApiSingle<{ id: string }>>('/helpdesk-announcements', data));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.announcements() });
    },
  });
}

// =============================================================================
// Mutations — News
// =============================================================================

export function useCreateNewsItem() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      title: string;
      content: string;
      htmlContent?: string;
      excerpt?: string;
      imageUrl?: string;
      authorId?: string;
      authorName?: string;
      status?: string;
      publishedAt?: string;
      tags?: string[];
    }) => {
      const client = await getClient();
      return toLegacy(await client.post<AppApiSingle<{ id: string }>>('/helpdesk-news', data));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.news() });
    },
  });
}

// =============================================================================
// Types — Shared types previously in action files
// =============================================================================

interface DashboardStats {
  totalTickets: number;
  openTickets: number;
  closedTickets: number;
  avgResponseTime: number;
  satisfactionRate: number;
  ticketsByStatus: Record<string, number>;
  ticketsByPriority: Record<string, number>;
  recentActivity: Array<{
    id: string;
    type: string;
    title: string;
    timestamp: Date;
  }>;
}

export interface AnalyticsReport {
  id: string;
  title: string;
  description: string | null;
  chartCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AnalyticsChart {
  id: string;
  reportId: string;
  title: string;
  description: string | null;
  chartType: string;
  entity: string;
  metric: string;
  color: string;
  smoothCurve: boolean;
  fillArea: boolean;
  showDataLabels: boolean;
  showLegend: boolean;
  timeRange: string | null;
  groupBy: string | null;
  aggregation: string | null;
  sortOrder: string | null;
  limit: number | null;
  compareWith: string | null;
  layout: { x: number; y: number; w: number; h: number; minW?: number; minH?: number };
  sortIndex: number;
}

interface AnalyticsChartDataPoint {
  label: string;
  value: number;
  date?: string;
}

export interface Announcement {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'success' | 'error';
  priority: 'low' | 'medium' | 'high' | 'critical';
  startDate: Date;
  endDate: Date | null;
  published: boolean;
  targetAudience: 'all' | 'customers' | 'internal' | 'vip';
  author: string;
  views: number;
  clicks: number;
}

export interface ChangelogEntry {
  id: string;
  version: string;
  title: string;
  description: string;
  type: 'feature' | 'improvement' | 'bugfix' | 'breaking';
  date: Date;
  published: boolean;
  author: string;
  tags: string[];
}

export interface NewsArticle {
  id: string;
  title: string;
  excerpt: string;
  content: string;
  author: string;
  category: 'company' | 'product' | 'industry' | 'announcement';
  status: 'draft' | 'published' | 'scheduled';
  publishDate: Date;
  views: number;
  featured: boolean;
  coverImage?: string;
  tags: string[];
}

export interface Review {
  id: string;
  customerName: string;
  customerEmail: string;
  rating: number;
  comment: string;
  date: Date;
  source: 'email' | 'chat' | 'website' | 'social';
  status: 'pending' | 'responded' | 'resolved';
  sentiment: 'positive' | 'neutral' | 'negative';
  agentName?: string;
  ticketId?: string;
  conversationId?: string;
  helpful?: number;
  notHelpful?: number;
}

export interface TicketMessage {
  id: string;
  ticketId: string;
  from: string;
  fromEmail: string;
  to: string[];
  cc: string[];
  subject: string;
  preview: string;
  bodyText: string;
  bodyHtml?: string;
  date: Date;
  isRead: boolean;
  isStarred: boolean;
  labels: string[];
  hasAttachments: boolean;
  channel: 'email' | 'chat' | 'phone' | 'social' | 'mentions';
  priority?: 'urgent' | 'high' | 'normal' | 'low';
  status?: 'open' | 'pending' | 'resolved' | 'closed';
  assignee?: string;
  ticketTypeId?: string;
  customFields?: Record<string, unknown>;
}

export interface ApiTicket {
  id: string;
  ticketNumber?: string;
  subject: string;
  description?: string;
  status: string;
  priority: string;
  source?: string;
  channel?: string;
  customerEmail?: string;
  customerName?: string;
  contactId?: string;
  assigneeId?: string;
  assigneeName?: string;
  departmentId?: string;
  ticketTypeId?: string;
  customFields?: Record<string, unknown>;
  tags?: string[];
  linkedConversations?: { id: string; subject: string | null; status: string | null; customerName: string | null; customerEmail: string | null; createdAt: string | null }[];
  createdAt: string;
  updatedAt: string;
}

interface TicketFilters {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  priority?: string;
  assigneeId?: string;
  ticketTypeId?: string;
  category?: string;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  location?: string;
  avatar?: string;
  tags: string[];
  status: 'active' | 'inactive' | 'vip';
  lastContact: Date;
  conversationCount: number;
  totalSpent: number;
  orderCount: number;
  loyaltyTier?: string;
  notes?: string;
}

export interface CompanyData {
  id: string;
  name: string;
}

export interface NotificationSettings {
  emailNotifications: boolean;
  pushNotifications: boolean;
  soundNotifications: boolean;
}

interface AppearanceSettings {
  compactMode: boolean;
  enableAnimations: boolean;
}

export interface TicketSettingsData {
  autoAssignment?: boolean;
  requireApproval?: boolean;
  allowCustomerCreation?: boolean;
  defaultPriority?: string;
  defaultStatus?: string;
  autoCloseAfterDays?: number;
  mergeThreshold?: number;
  assignmentStrategy?: 'round_robin' | 'least_busy' | 'manual';
}

export interface SatisfactionSettingsData {
  enableSurveys?: boolean;
  sendAfterResolution?: boolean;
  delayMinutes?: number;
  surveyTemplate?: string;
  thankYouMessage?: string;
}

export interface AutomationSettingsData {
  enabled: boolean;
  slaBreachAction?: 'escalate_and_notify' | 'notify_only' | 'none';
  priorityAlertThreshold?: ('urgent' | 'high')[];
}

export interface HelpdeskSettingsData {
  notifications: NotificationSettings;
  appearance: AppearanceSettings;
  widgetSettings?: any;
  tickets?: TicketSettingsData;
  satisfaction?: SatisfactionSettingsData;
  automation?: AutomationSettingsData;
}

export interface KnowledgeArticle {
  id: string;
  title: string;
  excerpt: string;
  category: string;
  categoryId?: string;
  tags: string[];
  author: string;
  views: number;
  lastUpdated: Date;
  status: 'published' | 'draft' | 'archived' | 'review' | 'outdated';
  visibility: 'public' | 'internal';
  helpful: number;
  notHelpful: number;
}

export interface MessageAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
}

// =============================================================================
// Additional Query Keys
// =============================================================================

// Extend helpdeskKeys with additional keys needed for new hooks
export const helpdeskExtraKeys = {
  dashboardActionItems: () => [...helpdeskKeys.all, 'dashboard', 'action-items'] as const,
  recentTickets: (limit?: number) => [...helpdeskKeys.all, 'dashboard', 'recent-tickets', limit] as const,
  chartData: (months?: number) => [...helpdeskKeys.all, 'dashboard', 'chart-data', months] as const,
  search: (query?: string) => [...helpdeskKeys.all, 'search', query] as const,
  agentTickets: (agentId: string, filters?: Record<string, any>) => [...helpdeskKeys.agents(), 'tickets', agentId, filters] as const,

  // Analytics
  analyticsReports: () => [...helpdeskKeys.all, 'analytics', 'reports'] as const,
  analyticsReport: (id: string) => [...helpdeskKeys.all, 'analytics', 'report', id] as const,
  analyticsCharts: (reportId: string) => [...helpdeskKeys.all, 'analytics', 'charts', reportId] as const,
  analyticsChartData: (config?: Record<string, any>) => [...helpdeskKeys.all, 'analytics', 'chart-data', config] as const,

  // Department Inbox Counts
  departmentInboxCounts: () => [...helpdeskKeys.all, 'department-inbox-counts'] as const,

  // Folder Badge Counts
  folderCounts: () => [...helpdeskKeys.all, 'folder-counts'] as const,

  // Conversations
  conversations: () => [...helpdeskKeys.all, 'conversations'] as const,
  conversationDetail: (id: string) => [...helpdeskKeys.all, 'conversations', 'detail', id] as const,
  conversationMessages: (id: string) => [...helpdeskKeys.all, 'conversations', 'messages', id] as const,
  conversationHistory: (email: string, excludeId: string) => [...helpdeskKeys.all, 'conversations', 'history', email, excludeId] as const,
  conversationReview: (id: string) => [...helpdeskKeys.all, 'conversations', 'review', id] as const,
  conversationAuditLogs: (id: string) => [...helpdeskKeys.all, 'conversations', 'audit-logs', id] as const,

  // Widget (legacy single-widget)
  widgetSettings: () => [...helpdeskKeys.all, 'widget', 'settings'] as const,

  // Widgets (multi-widget)
  widgets: () => [...helpdeskKeys.all, 'widgets'] as const,
  widgetDetail: (widgetId: string) => [...helpdeskKeys.all, 'widgets', widgetId] as const,

  // WeldAgent (AI removed platform-wide; keys kept only for the
  // now-neutralized ai-active/ai-resolved list queries below)
  weldagentAiActive: (filters?: Record<string, any>) => [...helpdeskKeys.all, 'weldagent', 'ai-active', filters] as const,
  weldagentAiResolved: (filters?: Record<string, any>) => [...helpdeskKeys.all, 'weldagent', 'ai-resolved', filters] as const,

  // Settings
  settings: () => [...helpdeskKeys.all, 'settings'] as const,

  // Ticket messages
  ticketMessages: (ticketId: string) => [...helpdeskKeys.tickets(), 'messages', ticketId] as const,

  // Folders
  folders: () => [...helpdeskKeys.all, 'folders'] as const,

  // Customers (CRM)
  customers: () => [...helpdeskKeys.all, 'customers'] as const,
  customerList: (filters?: Record<string, any>) => [...helpdeskKeys.all, 'customers', 'list', filters] as const,
  customerDetail: (id: string) => [...helpdeskKeys.all, 'customers', 'detail', id] as const,
  customerConversations: (id: string) => [...helpdeskKeys.all, 'customers', 'conversations', id] as const,
  companies: () => [...helpdeskKeys.all, 'companies'] as const,

  // News detail
  newsDetail: (id: string) => [...helpdeskKeys.news(), 'detail', id] as const,

  // Help articles (unified API)
  helpArticles: () => [...helpdeskKeys.all, 'help-articles'] as const,
  helpArticleList: (filters?: Record<string, any>) => [...helpdeskKeys.all, 'help-articles', 'list', filters] as const,
  helpArticleDetail: (id: string) => [...helpdeskKeys.all, 'help-articles', 'detail', id] as const,
  helpArticleStats: () => [...helpdeskKeys.all, 'help-articles', 'stats'] as const,
  helpFolders: () => [...helpdeskKeys.all, 'help-folders'] as const,

  // Users
  users: () => [...helpdeskKeys.all, 'users'] as const,

  // Stats
  helpdeskStats: () => [...helpdeskKeys.all, 'stats'] as const,
};

// =============================================================================
// Analytics Queries & Mutations
// =============================================================================
//
// NOTE: app-api mounts *reports* at the collection root (`/helpdesk-analytics`)
// but keeps the `/reports/:id/...` sub-paths — so list/create hit `/`, while
// get/duplicate/charts hit `/reports/:id`. That asymmetry is deliberate on the
// server; don't "tidy" these paths without changing the route file.

export function useAnalyticsReports() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.analyticsReports(),
    queryFn: async () => {
      const client = await getClient();
      return toLegacy(await client.get<AppApiSingle<any[]>>('/helpdesk-analytics'));
    },
  });
}

export function useAnalyticsReport(reportId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.analyticsReport(reportId),
    queryFn: async () => {
      const client = await getClient();
      return toLegacy(await client.get<AppApiSingle<any>>(`/helpdesk-analytics/reports/${reportId}`));
    },
    enabled: !!reportId,
  });
}

export function useAnalyticsCharts(reportId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.analyticsCharts(reportId),
    queryFn: async () => {
      const client = await getClient();
      return toLegacy(await client.get<AppApiSingle<any[]>>(`/helpdesk-analytics/reports/${reportId}/charts`));
    },
    enabled: !!reportId,
  });
}

export function useCreateAnalyticsReport() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { title: string; description?: string }) => {
      const client = await getClient();
      return toLegacy(await client.post<AppApiSingle<{ id: string }>>('/helpdesk-analytics', data));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.analyticsReports() });
    },
  });
}

export function useDeleteAnalyticsReport() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (reportId: string) => {
      const client = await getClient();
      // Unlike app-api's other deletes, this one answers `{ data: { id } }`.
      return toLegacy(await client.delete<AppApiSingle<{ id: string }>>(`/helpdesk-analytics/${reportId}`));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.analyticsReports() });
    },
  });
}

export function useDuplicateAnalyticsReport() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (reportId: string) => {
      const client = await getClient();
      return toLegacy(
        await client.post<AppApiSingle<{ id: string }>>(`/helpdesk-analytics/reports/${reportId}/duplicate`, {}),
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.analyticsReports() });
    },
  });
}

export function useCreateAnalyticsChart() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      reportId: string;
      title: string;
      description?: string;
      chartType: string;
      entity: string;
      metric: string;
      color?: string;
      smoothCurve?: boolean;
      fillArea?: boolean;
      showDataLabels?: boolean;
      showLegend?: boolean;
      timeRange?: string;
      groupBy?: string;
      aggregation?: string;
      sortOrder?: string;
      limit?: number;
      compareWith?: string;
      layout?: any;
    }) => {
      const client = await getClient();
      return toLegacy(await client.post<AppApiSingle<{ id: string }>>('/helpdesk-analytics/charts', data));
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.analyticsCharts(variables.reportId) });
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.analyticsReports() });
    },
  });
}

// =============================================================================
// Conversation Queries & Mutations
// =============================================================================

/**
 * NOTE: app-api `/conversations` is backed by `helpdeskConversations` — the
 * same table this hook has always read. It is NOT `/desk/conversations`, which
 * is a different table (`conversations`). Do not cross the two.
 *
 * Supported filters server-side: status, assigneeId, departmentId, search.
 * Anything else in `filters` is ignored by app-api rather than rejected.
 */
export function useConversations(filters?: Record<string, any>) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...helpdeskExtraKeys.conversations(), filters],
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString(toAppApiQuery(filters));
      const res = await client.get<AppApiList<any>>(`/conversations${query}`);
      return toLegacyList(res, filters);
    },
  });
}

export function useConversation(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.conversationDetail(id),
    queryFn: async () => {
      const client = await getClient();
      return toLegacy(await client.get<AppApiSingle<any>>(`/conversations/${id}`));
    },
    enabled: !!id && enabled,
  });
}

/**
 * W5b ported `helpdeskConversationMessages` to app-api, so the message thread
 * is on `/api/conversations/:id/messages` now. Still `/api/ticket-messages` is
 * a DIFFERENT table (helpdesk_ticket_messages) — do not cross the two.
 */
export function useConversationMessages(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.conversationMessages(id),
    queryFn: async () => {
      const client = await getClient();
      return toLegacy(await client.get<AppApiSingle<any[]>>(`/conversations/${id}/messages`));
    },
    enabled: !!id && enabled,
  });
}

export function useConversationReview(conversationId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.conversationReview(conversationId),
    queryFn: async () => {
      const client = await getClient();
      // `data` is null when the customer never left a CSAT rating.
      return toLegacy(await client.get<AppApiSingle<any>>(`/conversations/${conversationId}/review`));
    },
    enabled: !!conversationId,
  });
}

export function useConversationAuditLogs(conversationId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.conversationAuditLogs(conversationId),
    queryFn: async () => {
      const client = await getClient();
      return toLegacy(await client.get<AppApiSingle<any[]>>(`/conversations/${conversationId}/audit-logs`));
    },
    enabled: !!conversationId,
  });
}

// =============================================================================
// Widget Queries & Mutations
// =============================================================================

export function useUpdateWidgetSettings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Record<string, any>) => {
      const client = await getClient();
      return toLegacy(await client.put<AppApiSingle<any>>('/helpdesk-settings/widget', data));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.widgetSettings() });
    },
  });
}

// =============================================================================
// Multi-Widget Queries & Mutations
// =============================================================================

export function useWidgetsList() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.widgets(),
    queryFn: async () => {
      const client = await getClient();
      return toLegacy(await client.get<AppApiSingle<any[]>>('/helpdesk-settings/widgets'));
    },
  });
}

export function useWidgetById(widgetId: string) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.widgetDetail(widgetId),
    queryFn: async () => {
      const client = await getClient();
      return toLegacy(await client.get<AppApiSingle<any>>(`/helpdesk-settings/widgets/${widgetId}`));
    },
    enabled: !!widgetId,
  });
}

export function useCreateWidget() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { widgetName?: string }) => {
      const client = await getClient();
      return toLegacy(
        await client.post<AppApiSingle<{ id: string; widgetId: string; widgetName: string }>>(
          '/helpdesk-settings/widgets',
          data,
        ),
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.widgets() });
    },
  });
}

export function useUpdateWidgetById() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ widgetId, data }: { widgetId: string; data: Record<string, any> }) => {
      const client = await getClient();
      return toLegacy(
        await client.put<AppApiSingle<{ id: string; widgetId: string }>>(`/helpdesk-settings/widgets/${widgetId}`, data),
      );
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.widgets() });
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.widgetDetail(variables.widgetId) });
    },
  });
}

export function useDeleteWidget() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (widgetId: string) => {
      const client = await getClient();
      return toLegacy(await client.delete<AppApiSingle<{ success: boolean }>>(`/helpdesk-settings/widgets/${widgetId}`));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.widgets() });
    },
  });
}

// =============================================================================
// WeldAgent Queries — NEUTRALIZED
// =============================================================================
// AI was removed from WeldSuite (2026-07-08), including the weldagent_*
// tables (conversations, messages, user settings). The `/helpdesk/weldagent/*`
// endpoints are gone, so the two remaining consumers — the WeldDesk
// "AI active" / "AI resolved" sidebar list pages — no longer hit the
// network. They resolve to an empty list immediately, which keeps those
// pages mounted (no 404) showing a normal empty state instead of erroring.

export function useAiActiveConversations(_filters?: Record<string, any>) {
  return useQuery({
    queryKey: helpdeskExtraKeys.weldagentAiActive(_filters),
    queryFn: async () => ({
      success: true,
      data: { conversations: [] as any[], pagination: null },
    }),
    staleTime: Infinity,
  });
}

export function useAiResolvedConversations(_filters?: Record<string, any>) {
  return useQuery({
    queryKey: helpdeskExtraKeys.weldagentAiResolved(_filters),
    queryFn: async () => ({
      success: true,
      data: { conversations: [] as any[], pagination: null },
    }),
    staleTime: Infinity,
  });
}

// =============================================================================
// Settings Mutations
// =============================================================================

// The four settings writers below return app-api's `{ data: { success } }`
// unwrapped to `{ success }` — the bare shape the legacy worker returned and
// the settings screens still destructure.

export function useUpdateNotificationSettings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (settings: NotificationSettings) => {
      const client = await getClient();
      const res = await client.put<AppApiSingle<{ success: boolean }>>('/helpdesk-settings/notifications', {
        emailNotifications: settings.emailNotifications,
        pushNotifications: settings.pushNotifications,
        smsNotifications: settings.soundNotifications,
        notifyOnNewTicket: true,
        notifyOnAssignment: true,
        notifyOnStatusChange: true,
        notifyOnCustomerReply: true,
        notifyOnSLABreach: true,
      });
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.settings() });
    },
  });
}

export function useUpdateAutomationSettings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (settings: AutomationSettingsData) => {
      const client = await getClient();
      const res = await client.put<AppApiSingle<{ success: boolean }>>('/helpdesk-settings/automation', settings);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.settings() });
    },
  });
}

export function useUpdateTicketSettings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (settings: TicketSettingsData) => {
      const client = await getClient();
      const res = await client.put<AppApiSingle<{ success: boolean }>>('/helpdesk-settings/tickets', settings);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.settings() });
    },
  });
}

export function useUpdateSatisfactionSettings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (settings: SatisfactionSettingsData) => {
      const client = await getClient();
      const res = await client.put<AppApiSingle<{ success: boolean }>>('/helpdesk-settings/satisfaction', settings);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.settings() });
    },
  });
}

// =============================================================================
// Teams / Departments extra mutations
// =============================================================================

export function useCreateAgent() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      userId: string;
      name: string;
      email: string;
      role: string;
      departmentId: string;
      status?: string;
      availability?: string;
      maxActiveTickets?: number;
      skills?: string[];
      languages?: string[];
    }) => {
      const client = await getClient();
      return toLegacy(await client.post<AppApiSingle<{ id: string }>>('/helpdesk-agents', data));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.agents() });
    },
  });
}

export function useUpdateAgent() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Record<string, any> }) => {
      const client = await getClient();
      return toLegacy(await client.patch<AppApiSingle<{ id: string }>>(`/helpdesk-agents/${id}`, data));
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.agents() });
      qc.invalidateQueries({ queryKey: helpdeskKeys.agentDetail(variables.id) });
    },
  });
}

/**
 * app-api has no `/helpdesk-agents/:id/tickets` sub-collection; the equivalent
 * is the tickets list filtered by assignee.
 */
export function useAgentTickets(agentId: string, options?: { page?: number; limit?: number }) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.agentTickets(agentId, options),
    queryFn: async () => {
      const client = await getClient();
      const query = buildQueryString({ assigneeId: agentId, limit: Math.min(options?.limit || 10, APP_API_MAX_LIMIT) });
      const res = await client.get<AppApiList<any>>(`/tickets${query}`);
      return toLegacyList(res, { page: options?.page, pageSize: options?.limit });
    },
    enabled: !!agentId,
  });
}

export function useHelpdeskUsers() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.users(),
    queryFn: async () => {
      const client = await getClient();
      // `/helpdesk/users` was a thin projection of the workspace roster.
      const res = await client.get<AppApiList<any>>(`/team-members?limit=${APP_API_MAX_LIMIT}`);
      return { success: true as const, data: res.data };
    },
  });
}

// =============================================================================
// Folders
// =============================================================================

export function useHelpdeskFolders() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.folders(),
    queryFn: async () => {
      const client = await getClient();
      // app-api returns a cursor list ({ data, pagination }); the UI only reads `.data`.
      return client.get<{ data: any[]; pagination?: unknown }>('/article-folders?limit=100');
    },
  });
}

export function useCreateKnowledgeFolder() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; parentId?: string }) => {
      const client = await getClient();
      return client.post<{ data: { id: string } }>('/article-folders', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.folders() });
    },
  });
}

export function useUpdateFolder() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: { name?: string; parentId?: string | null; sortOrder?: number } }) => {
      const client = await getClient();
      return client.patch<{ data: { id: string } }>(`/article-folders/${id}`, data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.folders() });
    },
  });
}

export function useDeleteFolder() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/article-folders/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.folders() });
    },
  });
}

// =============================================================================
// Customers (CRM via helpdesk)
// =============================================================================
//
// W5b remap. api-worker deleted `crm/customers.ts` (commit 42ff1442a) while
// the platform kept calling it, so every hook here 404s today.
//
// These hooks are named "customer" but the grid they serve is fed by
// `useHelpdeskContacts` → `/helpdesk-contacts`, which is backed by the shared
// `people` table (as api-worker's `/helpdesk/contacts` already was). The rows
// therefore carry `person_*` ids, while `/crm/customers/:id` addressed
// `parties` (`cust_*` / `pty_*`). The ids could never match, so the grid's
// inline edit and delete have been 404-ing against a table that never held
// their rows — a latent bug that predates the phase-out.
//
// The remap points each hook at the route that owns the row it is actually
// holding, which also repairs that mismatch:
//   detail/create/update → `/helpdesk-contacts` (same route family + id space
//                          as the list, so a row edited here is the row shown)
//   delete               → `/people/:id` (helpdesk-contacts has no DELETE by
//                          design — "contacts are owned by WeldCRM"). Soft
//                          (`deletedAt`) and owner-scoped, matching the legacy
//                          soft-delete, and `people:delete` is admin-only just
//                          as legacy's `contacts:delete` was — no tier change.
//   companies            → `/companies` (the b2b projection legacy faked with
//                          `?type=b2b` over parties)
//
// Envelopes are preserved via toLegacy/toLegacyList. NOTE: the consumers read
// fields these endpoints have never returned (`.customer` on the detail page,
// `.companies` here) — see the report; that is consumer-side work.

export function useHelpdeskCustomer(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.customerDetail(id),
    queryFn: async () => {
      const client = await getClient();
      return toLegacy(await client.get<AppApiSingle<any>>(`/helpdesk-contacts/${id}`));
    },
    enabled: !!id && enabled,
  });
}

export function useCreateHelpdeskCustomer() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { firstName: string; lastName: string; email: string; phone?: string; company?: string; accountStatus?: string }) => {
      const client = await getClient();
      // `/helpdesk-contacts` requires `name`; the party-shaped `fullName` /
      // `type: b2b|b2c` / `companyName` fields have no equivalent on `people`.
      // `company` is dropped rather than guessed at — linking a person to a
      // company is `/person-companies`, a separate relation.
      return toLegacy(
        await client.post<AppApiSingle<any>>('/helpdesk-contacts', {
          name: `${data.firstName} ${data.lastName}`.trim() || data.email,
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email,
          phone: data.phone,
          status: data.accountStatus === 'inactive' ? 'inactive' : 'active',
        }),
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.customers() });
      qc.invalidateQueries({ queryKey: helpdeskKeys.contacts() });
    },
  });
}

export function useUpdateHelpdeskCustomer() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Record<string, any> }) => {
      const client = await getClient();
      return toLegacy(await client.patch<AppApiSingle<any>>(`/helpdesk-contacts/${id}`, data));
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.customers() });
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.customerDetail(variables.id) });
      qc.invalidateQueries({ queryKey: helpdeskKeys.contacts() });
    },
  });
}

export function useDeleteHelpdeskCustomer() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      // app-api answers 204 No Content; the grid still checks `.success`.
      await client.delete<void>(`/people/${id}`);
      return { success: true as const };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.customers() });
      qc.invalidateQueries({ queryKey: helpdeskKeys.contacts() });
    },
  });
}

export function useHelpdeskCompanies() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.companies(),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<AppApiList<any>>(`/companies${buildQueryString({ limit: 100 })}`);
      return toLegacyList(res, { pageSize: 100 });
    },
  });
}

export function useHelpdeskCustomerConversations(customerId: string, page = 1, pageSize = 20) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.customerConversations(customerId),
    queryFn: async () => {
      const client = await getClient();
      // Pre-existing quirk, preserved: the legacy call never filtered by
      // `customerId` either — it lists the workspace's conversations and the
      // page renders them under the customer.
      const query = buildQueryString({ limit: Math.min(pageSize, APP_API_MAX_LIMIT) });
      const res = await client.get<AppApiList<any>>(`/conversations${query}`);
      return toLegacyList(res, { page, pageSize });
    },
    enabled: !!customerId,
  });
}

// =============================================================================
// News detail
// =============================================================================

export function useNewsArticle(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.newsDetail(id),
    queryFn: async () => {
      const client = await getClient();
      return toLegacy(await client.get<AppApiSingle<any>>(`/helpdesk-news/${id}`));
    },
    enabled: !!id && enabled,
  });
}

// =============================================================================
// Help Articles (app-api `/articles` + `/article-folders`)
// =============================================================================
//
// W5b: these called `/api/helpdesk/articles` + `/api/helpdesk/article-folders`
// through the unified client, and api-worker deleted both (commit 44a93606e),
// so they 404 today. They are now pointed at the live `/articles` +
// `/article-folders` routes — the same ones this file already wraps as
// `useArticles` / `useArticle` / `useCreateArticle` / `useHelpdeskFolders`.
//
// This block is retained rather than deleted because `app/welddesk/help/*`
// still imports every hook below; collapsing the duplication means repointing
// those pages at the `useArticle*` hooks, a consumer-side change owned by the
// WeldDesk-UI work package.
//
// Each hook keeps its *unwrapped* return shape (the unified client returned
// rows, not `{ data }`), so the observable contract is unchanged. app-api's
// `folderId` replaces the unified client's `categoryId`/`categoryName`, and
// cursor paging replaces page paging.

export function useHelpArticle(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.helpArticleDetail(id),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<AppApiSingle<any>>(`/articles/${id}`);
      return res.data;
    },
    enabled: !!id && enabled,
  });
}

export function useHelpArticleStats() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.helpArticleStats(),
    queryFn: async () => {
      const client = await getClient();
      // The unified client asked for 1000; app-api hard-caps `limit` at 100.
      const query = buildQueryString({ limit: APP_API_MAX_LIMIT });
      return client.get<AppApiList<any>>(`/articles${query}`);
    },
  });
}

export function useHelpFolders(tree = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.helpFolders(),
    queryFn: async () => {
      const client = await getClient();
      // `/article-folders` has no `tree` mode — it always returns a flat list
      // (rows carry `parentId`, so callers can nest client-side).
      const query = buildQueryString({ limit: APP_API_MAX_LIMIT });
      const res = await client.get<AppApiList<any>>(`/article-folders${query}`);
      return res.data;
    },
  });
}

export function useCreateHelpArticle() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { title: string; content: string; excerpt?: string; category?: string; tags?: string[]; status: string; coverImage?: string }) => {
      const client = await getClient();
      const res = await client.post<AppApiSingle<any>>('/articles', {
        title: data.title,
        content: data.content,
        excerpt: data.excerpt,
        // `category` carries a folder id in this UI; `categoryName` and
        // `coverImage` have no column on `/articles` and are dropped rather
        // than sent to be silently stripped.
        folderId: data.category || undefined,
        tags: data.tags,
        status: data.status,
      });
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.helpArticles() });
      qc.invalidateQueries({ queryKey: helpdeskKeys.articles() });
    },
  });
}

export function useCreateHelpFolder() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; parentId?: string; description?: string; icon?: string; color?: string }) => {
      const client = await getClient();
      const res = await client.post<AppApiSingle<any>>('/article-folders', data);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.helpFolders() });
    },
  });
}

export function useDeleteHelpFolder() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete<void>(`/article-folders/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.helpFolders() });
    },
  });
}

export function useDeleteHelpArticle() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete<void>(`/articles/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskExtraKeys.helpArticles() });
      qc.invalidateQueries({ queryKey: helpdeskKeys.articles() });
    },
  });
}

// =============================================================================
// Queries — Ticket Types
// =============================================================================

interface TicketTypeFieldOption {
  label: string;
  value: string;
}

export interface TicketTypeFieldCondition {
  field: string; // key of the field to check
  operator: 'equals' | 'not_equals' | 'is_set' | 'is_not_set';
  value?: string;
}

export interface TicketTypeField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'multiselect' | 'date' | 'checkbox' | 'email' | 'url';
  required: boolean;
  placeholder?: string;
  options?: TicketTypeFieldOption[];
  helpText?: string;
  order: number;
  isDefault?: boolean;
  teammateVisible?: boolean;
  customerVisible?: boolean;
  conditions?: TicketTypeFieldCondition[];
}

interface TicketTypeState {
  key: string;
  label: string;
  customerLabel: string;
}

export interface TicketTypeStateGroup {
  groupKey: 'submitted' | 'in_progress' | 'waiting_on_customer' | 'resolved';
  groupLabel: string;
  customerGroupLabel: string;
  states: TicketTypeState[];
}

export interface TicketTypeConfig {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  category?: string;
  fields: TicketTypeField[];
  states?: TicketTypeStateGroup[];
  disableAiAutofill?: boolean;
  defaultPriority?: string;
  defaultAssigneeId?: string;
  defaultDepartmentId?: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function useTicketTypes() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.ticketTypeLists(),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<AppApiList<TicketTypeConfig>>(`/ticket-types?limit=${APP_API_MAX_LIMIT}`);
      return res.data || [];
    },
  });
}

export function useCreateTicketType() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Omit<TicketTypeConfig, 'id' | 'createdAt' | 'updatedAt'>) => {
      const client = await getClient();
      return toLegacy(await client.post<AppApiSingle<{ id: string }>>('/ticket-types', data));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.ticketTypes() });
    },
  });
}

export function useUpdateTicketType() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...data }: Partial<TicketTypeConfig> & { id: string }) => {
      const client = await getClient();
      return toLegacy(await client.patch<AppApiSingle<{ id: string }>>(`/ticket-types/${id}`, data));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.ticketTypes() });
    },
  });
}

export function useDeleteTicketType() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete<void>(`/ticket-types/${id}`);
      return { success: true as const };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.ticketTypes() });
    },
  });
}

// =============================================================================
// Queries — Department Inbox Counts
// =============================================================================

// W5b added `/helpdesk-departments/inbox-counts` to app-api (declared above
// `/:id`, which would otherwise swallow it).
export function useDepartmentInboxCounts() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.departmentInboxCounts(),
    queryFn: async () => {
      const client = await getClient();
      return toLegacy(
        await client.get<AppApiSingle<Array<{ departmentId: string; activeCount: number }>>>(
          '/helpdesk-departments/inbox-counts',
        ),
      );
    },
    refetchInterval: 30000,
  });
}

// =============================================================================
// Queries — Folder Badge Counts
// =============================================================================

export interface HelpdeskFolderCounts {
  all: number;
  chat: number;
  unassigned: number;
  mine: number;
  active: number;
  pending: number;
  resolved: number;
  closed: number;
}

export function useHelpdeskFolderCounts() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskExtraKeys.folderCounts(),
    queryFn: async (): Promise<HelpdeskFolderCounts> => {
      const client = await getClient();
      const result = await client.get<AppApiSingle<HelpdeskFolderCounts>>('/conversations/folder-counts');
      return result.data || { all: 0, chat: 0, unassigned: 0, mine: 0, active: 0, pending: 0, resolved: 0, closed: 0 };
    },
    refetchInterval: 30000,
  });
}

// =============================================================================
// Queries — Help Center Settings
// =============================================================================

export function useHelpcenterSettings() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.helpcenterSettings(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: any }>('/helpcenter-settings');
      return result.data;
    },
  });
}

export function useUpdateHelpcenterSettings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Record<string, any>) => {
      const client = await getClient();
      return client.put<{ data: any }>('/helpcenter-settings', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.helpcenterSettings() });
    },
  });
}

export function useEnableHelpcenter() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (_data?: Record<string, unknown>) => {
      const client = await getClient();
      return client.post<{ data: { domain: string; slug: string; enabled: boolean } }>('/helpcenter-settings/enable', {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.helpcenter() });
    },
  });
}

// =============================================================================
// Queries — Help Center Domains
// =============================================================================

export function useHelpcenterDomains() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskKeys.helpcenterDomains(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: any[] }>('/helpcenter-settings/domains');
      return result.data || [];
    },
  });
}

/** WeldHost domains eligible for one-click help-center attach. */
export function useHelpcenterHostDomains() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...helpdeskKeys.helpcenter(), 'host-domains'] as const,
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<{ data: Array<{ id: string; fullDomain: string; hasZone: boolean }> }>('/helpcenter-settings/host-domains');
      return result.data || [];
    },
  });
}

export function useAddHelpcenterDomain() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { hostDomainId?: string; subdomain?: string; domain?: string }) => {
      const client = await getClient();
      return client.post<{ data: any }>('/helpcenter-settings/domains', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.helpcenterDomains() });
      qc.invalidateQueries({ queryKey: helpdeskKeys.helpcenterSettings() });
    },
  });
}

export function useVerifyHelpcenterDomain() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<{ data: { verified: boolean; domain: string } }>(`/helpcenter-settings/domains/${id}/verify`, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.helpcenterDomains() });
      qc.invalidateQueries({ queryKey: helpdeskKeys.helpcenterSettings() });
    },
  });
}

export function useDeleteHelpcenterDomain() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/helpcenter-settings/domains/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskKeys.helpcenterDomains() });
      qc.invalidateQueries({ queryKey: helpdeskKeys.helpcenterSettings() });
    },
  });
}
