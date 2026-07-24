/**
 * Helpdesk Domain API
 *
 * Client for helpdesk operations. Every method goes to the unified app-api
 * worker via the `appApi` module singleton — the legacy api-worker transport is
 * fully phased out of this module.
 *
 * What this module guarantees
 * ---------------------------
 * 1. Transport: app-api only, through the `appApi` singleton. None of the legacy
 *    api-worker clients, hooks, or their base-URL env var remain in this module.
 * 2. Envelope: app-api's `{ data }` / `{ data, pagination }` + cursor pagination
 *    are adapted back to the legacy `{ success, data, pagination }` +
 *    page/pageSize contract inside this module, so the shape callers destructure
 *    stays stable. See the "app-api envelope adapters" note below for the
 *    page/pageSize echo caveat.
 * 3. Live callers keep working. The only importer is
 *    `app/welddesk/inbox/all/[conversationId]/conversation-detail-client.tsx`,
 *    which uses `listAgents`, `listDepartments`, `assignConversation`, and
 *    `assignConversationTeam`.
 *
 * What this module does NOT guarantee
 * -----------------------------------
 * The exported surface is NOT frozen at its api-worker shape, and parity with
 * api-worker is explicitly not a goal:
 *
 * - Methods get deleted when they are dead. This round removed `search`,
 *   `getDashboardStats`, `getTicketStats`, `addTicketNote`, `escalateTicket`,
 *   the five `*ChangelogEntry` methods, `duplicateAnalyticsChart`, and the
 *   exported `SearchResult` interface — all unreachable, several already 404 in
 *   production. Prove a method is unreachable (grep for call sites) before
 *   deleting it, then delete it rather than porting a dead endpoint.
 * - Return shapes follow app-api's actual response, not api-worker's. Where
 *   api-worker's runtime shape contradicted the type this module exports,
 *   app-api's column-shaped row wins: `replyToTicket` and `getTicketMessages`
 *   both return `body` / `htmlBody` / `authorType` (matching the exported
 *   `TicketMessage`), not api-worker's `content` / `senderType` / `senderName` /
 *   `isRead`. Individual methods document their own deviations.
 *
 * Note for future rounds: most methods here have no call sites — the four listed
 * above are the reachable surface. Treat the rest as prune candidates, not as
 * contract, and re-grep before assuming any given method carries traffic.
 */

import { appApi } from '../app-api-browser-client';
import type { Helpdesk } from '../types/apps/helpdesk.types';

// ============================================================================
// Re-export core types from the central type definitions
// ============================================================================

type Conversation = Helpdesk.Conversation;
export type ConversationMessage = Helpdesk.ConversationMessage;
export type Ticket = Helpdesk.Ticket;
export type TicketMessage = Helpdesk.TicketMessage;

// ============================================================================
// Filter Types (for API requests)
// ============================================================================

export interface TicketFilters {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  priority?: string;
  assigneeId?: string;
  departmentId?: string;
  contactId?: string;
  ticketTypeId?: string;
}

export interface ConversationFilters {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  priority?: string;
  assigneeId?: string;
  channel?: string;
  departmentId?: string;
  isRead?: boolean;
  isStarred?: boolean;
  isArchived?: boolean;
  customerEmail?: string;
}

// ============================================================================
// Response Types
// ============================================================================

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasMore: boolean;
}

export interface CannedResponse {
  id: string;
  name: string;
  subject: string | null;
  content: string;
  category: string | null;
  scope: 'personal' | 'team' | 'department' | 'global';
  agentId: string | null;
  teamId: string | null;
  departmentId: string | null;
  usageCount: number | null;
  lastUsedAt: string | null;
  shortcut: string | null;
  keywords: string[] | null;
  actions: Array<{ type: string; value: unknown }> | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationsResponse {
  success: boolean;
  data: Conversation[];
  pagination: PaginationMeta;
}

export interface ConversationResponse {
  success: boolean;
  data: Conversation;
}

export interface ConversationMessagesResponse {
  success: boolean;
  data: ConversationMessage[];
}

export interface TicketsResponse {
  success: boolean;
  data: Ticket[];
  pagination: PaginationMeta;
}

export interface TicketResponse {
  success: boolean;
  data: Ticket;
}

export interface TicketMessagesResponse {
  success: boolean;
  data: TicketMessage[];
}

export interface ConversationReview {
  id: string;
  rating: number;
  content: string;
  reviewerName: string;
  reviewerEmail: string;
  createdAt: string;
}

// ============================================================================
// Request Types
// ============================================================================

export interface CreateTicketData {
  subject: string;
  description?: string;
  descriptionHtml?: string;
  priority?: 'urgent' | 'high' | 'normal' | 'low';
  source?: string;
  customerEmail: string;
  customerName?: string;
  contactId?: string;
  assigneeId?: string;
  departmentId?: string;
  tags?: string[];
  conversationId?: string;
  ticketTypeId?: string;
  customFields?: Record<string, unknown>;
}

export interface UpdateTicketData {
  subject?: string;
  description?: string;
  descriptionHtml?: string;
  status?: 'open' | 'pending' | 'resolved' | 'closed';
  priority?: 'urgent' | 'high' | 'normal' | 'low';
  assigneeId?: string;
  departmentId?: string;
  tags?: string[];
  ticketTypeId?: string;
  customFields?: Record<string, unknown>;
}

// ============================================================================
// Helper Functions
// ============================================================================

function buildQueryString(params: Record<string, unknown>): string {
  const queryParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      queryParams.set(key, String(value));
    }
  }

  const query = queryParams.toString();
  return query ? `?${query}` : '';
}

// ============================================================================
// app-api envelope adapters
//
// app-api returns `{ data }` / `{ data, pagination: { totalCount, hasMore,
// cursor } }`; the legacy contract these methods still advertise is
// `{ success, data, pagination: { page, pageSize, totalCount, totalPages,
// hasMore } }`. `page`/`pageSize` are not derivable from a cursor, so they are
// echoed back from the request. That echo is only ever truthful for the first
// page, which is why `listQuery` below refuses `page > 1` outright rather than
// letting the meta claim a page the rows don't come from.
// ============================================================================

/** Shape of an app-api list response. */
interface AppApiList<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

/** Shape of an app-api single-entity response. */
interface AppApiSingle<T> {
  data: T;
}

const DEFAULT_PAGE_SIZE = 25;

function toPaginationMeta(
  page: number | undefined,
  pageSize: number | undefined,
  totalCount: number,
  hasMore: boolean,
): PaginationMeta {
  const size = pageSize && pageSize > 0 ? pageSize : DEFAULT_PAGE_SIZE;
  return {
    page: page ?? 1,
    pageSize: size,
    totalCount,
    totalPages: Math.ceil(totalCount / size),
    hasMore,
  };
}

/** Adapt an app-api list response to the legacy `{ success, data, pagination }`. */
function adaptList<T>(
  res: AppApiList<T>,
  page?: number,
  pageSize?: number,
): { success: boolean; data: T[]; pagination: PaginationMeta } {
  return {
    success: true,
    data: res.data,
    pagination: toPaginationMeta(page, pageSize, res.pagination?.totalCount ?? res.data.length, res.pagination?.hasMore ?? false),
  };
}

/** Adapt an app-api single response to the legacy `{ success, data }`. */
function adaptSingle<T>(res: AppApiSingle<T>): { success: boolean; data: T } {
  return { success: true, data: res.data };
}

/** Row shape returned by `/helpdesk-agents`. */
interface HelpdeskAgentRecord {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  departmentId?: string;
  status: string;
  availability: string;
  maxActiveTickets: number;
  currentActiveTickets: number;
  skills?: string[];
  languages?: string[];
  createdAt: string;
  updatedAt: string;
}

/** Row shape returned by `/helpdesk-news`. */
interface HelpdeskNewsRecord {
  id: string;
  title: string;
  excerpt: string;
  content: string;
  author: string;
  category: string;
  status: string;
  publishDate: string;
  views: number;
  featured: boolean;
  coverImage?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** Grid position for an analytics chart (react-grid-layout compatible). */
interface HelpdeskChartLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

/** Row shape returned by `/helpdesk-analytics` (report). */
interface HelpdeskAnalyticsReportRecord {
  id: string;
  title: string;
  description: string | null;
  chartCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Row shape returned by the helpdesk analytics charts endpoint. */
interface HelpdeskAnalyticsChartRecord {
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
  layout: HelpdeskChartLayout;
  sortIndex: number;
}

/** Row shape returned by `/helpdesk-departments`. */
interface HelpdeskDepartmentRecord {
  id: string;
  name: string;
  description?: string;
  email?: string;
  managerId?: string;
  managerName?: string;
  agentCount?: number;
  autoAssignment?: boolean;
  roundRobinAssignment?: boolean;
  categories?: string[];
  defaultPriority?: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Adapt an app-api route that returns a bare `{ data: T[] }` (no pagination
 * block) to the legacy paginated contract — the count is the array itself.
 */
function adaptArrayAsList<T>(
  res: AppApiSingle<T[]>,
  page?: number,
  pageSize?: number,
): { success: boolean; data: T[]; pagination: PaginationMeta } {
  return {
    success: true,
    data: res.data,
    pagination: toPaginationMeta(page, pageSize, res.data.length, false),
  };
}

/**
 * app-api maps the legacy `page`/`pageSize` pair onto its cursor pagination's
 * `limit`. "The first N rows" (`page` absent or 1) is expressible; a deep
 * `page=3` jump is not — app-api paginates by opaque cursor and takes no
 * offset.
 *
 * Such a request therefore throws rather than silently returning page-1 rows
 * under a `pagination` meta that echoes the requested page back. No caller
 * paginates today, but `page` is still exported on `TicketFilters` /
 * `ConversationFilters`, so the next one to wire it up must get a loud failure
 * here instead of plausible-looking wrong rows.
 */
function listQuery<F extends { page?: number; pageSize?: number }>(
  filters: F,
  extra?: Record<string, unknown>,
): string {
  const { page, pageSize, ...rest } = filters;
  if (page !== undefined && page > 1) {
    throw new Error(
      `welddesk: page=${page} is not supported — app-api paginates by cursor, not offset. ` +
        `Page through with the cursor returned by the previous response instead.`,
    );
  }
  return buildQueryString({ ...rest, ...(extra ?? {}), limit: pageSize });
}

// ============================================================================
// Helpdesk Worker API
// ============================================================================

export const helpdeskWorkerApi = {
  // -------------------------------------------------------------------------
  // Tickets
  // -------------------------------------------------------------------------

  /**
   * List tickets with optional filters
   */
  async listTickets(filters: TicketFilters = {}): Promise<TicketsResponse> {
    const res = await appApi.get<AppApiList<Ticket>>(`/tickets${listQuery(filters)}`);
    return adaptList(res, filters.page, filters.pageSize);
  },

  /**
   * Get a single ticket by ID
   */
  async getTicket(id: string): Promise<TicketResponse> {
    return adaptSingle(await appApi.get<AppApiSingle<Ticket>>(`/tickets/${id}`));
  },

  /**
   * Create a new ticket
   */
  async createTicket(data: CreateTicketData): Promise<TicketResponse> {
    return adaptSingle(await appApi.post<AppApiSingle<Ticket>>('/tickets', data));
  },

  /**
   * Update a ticket
   */
  async updateTicket(id: string, data: UpdateTicketData): Promise<TicketResponse> {
    return adaptSingle(await appApi.patch<AppApiSingle<Ticket>>(`/tickets/${id}`, data));
  },

  /**
   * Update ticket status
   */
  async updateTicketStatus(id: string, status: string): Promise<{ success: boolean }> {
    await appApi.patch(`/tickets/${id}`, { status });
    return { success: true };
  },

  /**
   * Update ticket priority
   */
  async updateTicketPriority(id: string, priority: string): Promise<{ success: boolean }> {
    await appApi.patch(`/tickets/${id}`, { priority });
    return { success: true };
  },

  /**
   * Assign ticket to an agent
   */
  async assignTicket(id: string, assigneeId: string): Promise<{ success: boolean }> {
    await appApi.patch(`/tickets/${id}`, { assigneeId });
    return { success: true };
  },

  /**
   * Add tags to a ticket
   *
   * Note: `/tickets/:id/tags` — NOT `PATCH /tickets/:id { tags }`, whose `tags`
   * **replaces** the column. This route merges, which is what "add tags" means.
   */
  async addTicketTags(id: string, tags: string[]): Promise<{ success: boolean }> {
    await appApi.patch(`/tickets/${id}/tags`, { tags });
    return { success: true };
  },

  /**
   * Close a ticket
   */
  async closeTicket(id: string): Promise<{ success: boolean }> {
    await appApi.patch(`/tickets/${id}`, { status: 'closed' });
    return { success: true };
  },

  /**
   * Delete a ticket (soft delete)
   */
  async deleteTicket(id: string): Promise<{ success: boolean }> {
    await appApi.delete(`/tickets/${id}`);
    return { success: true };
  },

  // -------------------------------------------------------------------------
  // Ticket Messages
  // -------------------------------------------------------------------------

  /**
   * Get messages for a ticket
   *
   * Note: app-api returns the column-shaped row (`body` / `htmlBody` /
   * `authorType`), which is what the exported `TicketMessage` type has always
   * declared — api-worker's runtime shape (`content` / `senderType`) never
   * matched it. Ordering is normalised to ascending (thread order) here because
   * app-api lists newest-first; the page is capped at 100 messages per ticket.
   */
  async getTicketMessages(ticketId: string): Promise<TicketMessagesResponse> {
    const res = await appApi.get<AppApiList<TicketMessage>>(
      `/ticket-messages${buildQueryString({ ticketId, limit: 100 })}`,
    );
    const data = [...res.data].sort(
      (a, b) => new Date(a.createdAt as unknown as string).getTime() - new Date(b.createdAt as unknown as string).getTime(),
    );
    return { success: true, data };
  },

  /**
   * Reply to a ticket
   *
   * Note: `/tickets/:id/messages` — NOT the generic `POST /ticket-messages`,
   * which takes the author from the body (its `authorName` / `authorEmail`
   * columns are NOT NULL) and leaves the parent ticket's `updatedAt` stale.
   * This route derives the author from the Clerk session and bumps the ticket.
   *
   * Returns the column-shaped row (`body` / `htmlBody` / `authorType`), which is
   * what the exported `TicketMessage` type declares and what `getTicketMessages`
   * already returns — api-worker's runtime shape here (`content` / `senderType`)
   * never matched either.
   */
  async replyToTicket(ticketId: string, data: {
    content: string;
    contentHtml?: string;
    isInternal?: boolean;
  }): Promise<{ success: boolean; data: TicketMessage }> {
    return adaptSingle(
      await appApi.post<AppApiSingle<TicketMessage>>(`/tickets/${ticketId}/messages`, data),
    );
  },

  // -------------------------------------------------------------------------
  // Conversations (Chat)
  // -------------------------------------------------------------------------

  /**
   * List conversations with filters
   */
  async listConversations(filters: ConversationFilters = {}): Promise<ConversationsResponse> {
    const res = await appApi.get<AppApiList<Conversation>>(`/conversations${listQuery(filters)}`);
    return adaptList(res, filters.page, filters.pageSize);
  },

  /**
   * Get a conversation by ID
   */
  async getConversation(id: string): Promise<ConversationResponse> {
    return adaptSingle(await appApi.get<AppApiSingle<Conversation>>(`/conversations/${id}`));
  },

  /**
   * Get messages in a conversation
   */
  async getConversationMessages(conversationId: string): Promise<ConversationMessagesResponse> {
    return adaptSingle(
      await appApi.get<AppApiSingle<ConversationMessage[]>>(`/conversations/${conversationId}/messages`),
    );
  },

  /**
   * Get review for a conversation
   */
  async getConversationReview(conversationId: string): Promise<{ success: boolean; data: ConversationReview | null }> {
    return adaptSingle(
      await appApi.get<AppApiSingle<ConversationReview | null>>(`/conversations/${conversationId}/review`),
    );
  },

  /**
   * Send message in a conversation
   */
  async sendConversationMessage(conversationId: string, data: {
    content: string;
    contentHtml?: string;
    isInternal?: boolean;
    authorName?: string;
    attachments?: Array<{
      id: string;
      fileName: string;
      fileSize: number;
      mimeType: string;
      url: string;
    }>;
  }): Promise<{ success: boolean; data: ConversationMessage }> {
    return adaptSingle(
      await appApi.post<AppApiSingle<ConversationMessage>>(`/conversations/${conversationId}/messages`, data),
    );
  },

  /**
   * Update conversation status
   */
  async updateConversationStatus(id: string, status: string): Promise<ConversationResponse> {
    return adaptSingle(
      await appApi.patch<AppApiSingle<Conversation>>(`/conversations/${id}/status`, { status }),
    );
  },

  /**
   * Update conversation priority
   */
  async updateConversationPriority(id: string, priority: string): Promise<ConversationResponse> {
    return adaptSingle(
      await appApi.patch<AppApiSingle<Conversation>>(`/conversations/${id}/priority`, { priority }),
    );
  },

  /**
   * Assign conversation to an agent
   */
  async assignConversation(id: string, assigneeId: string, assigneeName?: string): Promise<ConversationResponse> {
    return adaptSingle(
      await appApi.patch<AppApiSingle<Conversation>>(`/conversations/${id}/assign`, { assigneeId, assigneeName }),
    );
  },

  /**
   * Assign conversation to a team (department)
   *
   * Note: `/conversations/:id/assign-team` — NOT `PATCH /conversations/:id
   * { departmentId }`. Transferring also clears the current assignee and then
   * hands the conversation to the team's next agent (department round-robin /
   * load balancing), reporting `autoAssigned`. The generic PATCH would set the
   * department and strand the conversation unassigned.
   */
  async assignConversationTeam(
    id: string,
    departmentId: string,
    assigneeId?: string | null,
    assigneeName?: string | null
  ): Promise<ConversationResponse> {
    return adaptSingle(
      await appApi.patch<AppApiSingle<Conversation>>(`/conversations/${id}/assign-team`, {
        departmentId,
        assigneeId,
        assigneeName,
      }),
    );
  },

  /**
   * Get active conversation counts per department
   */
  async getDepartmentInboxCounts(): Promise<{
    success: boolean;
    data: Array<{ departmentId: string; activeCount: number }>;
  }> {
    return adaptSingle(
      await appApi.get<AppApiSingle<Array<{ departmentId: string; activeCount: number }>>>(
        '/helpdesk-departments/inbox-counts',
      ),
    );
  },

  /**
   * Assign customer to conversation
   */
  async assignConversationContact(id: string, contactId: string | null): Promise<ConversationResponse> {
    return adaptSingle(
      await appApi.patch<AppApiSingle<Conversation>>(`/conversations/${id}/contact`, { contactId }),
    );
  },

  /**
   * Mark conversation as read
   */
  async markConversationAsRead(id: string): Promise<ConversationResponse> {
    return adaptSingle(
      await appApi.patch<AppApiSingle<Conversation>>(`/conversations/${id}/read`, { isRead: true }),
    );
  },

  /**
   * Mark conversation as unread
   */
  async markConversationAsUnread(id: string): Promise<ConversationResponse> {
    return adaptSingle(
      await appApi.patch<AppApiSingle<Conversation>>(`/conversations/${id}/read`, { isRead: false }),
    );
  },

  /**
   * Toggle conversation star
   */
  async toggleConversationStar(id: string, isStarred: boolean): Promise<ConversationResponse> {
    return adaptSingle(
      await appApi.patch<AppApiSingle<Conversation>>(`/conversations/${id}/star`, { isStarred: !isStarred }),
    );
  },

  /**
   * Archive a conversation
   */
  async archiveConversation(id: string): Promise<ConversationResponse> {
    return adaptSingle(
      await appApi.patch<AppApiSingle<Conversation>>(`/conversations/${id}/archive`, { isArchived: true }),
    );
  },

  /**
   * Unarchive a conversation
   */
  async unarchiveConversation(id: string): Promise<ConversationResponse> {
    return adaptSingle(
      await appApi.patch<AppApiSingle<Conversation>>(`/conversations/${id}/archive`, { isArchived: false }),
    );
  },

  /**
   * Delete a conversation
   */
  async deleteConversation(id: string): Promise<{ success: boolean }> {
    await appApi.delete(`/conversations/${id}`);
    return { success: true };
  },

  /**
   * Close a conversation
   */
  async closeConversation(id: string): Promise<ConversationResponse> {
    return adaptSingle(
      await appApi.patch<AppApiSingle<Conversation>>(`/conversations/${id}/status`, { status: 'closed' }),
    );
  },

  /**
   * Snooze a conversation
   */
  async snoozeConversation(id: string, until: Date): Promise<ConversationResponse> {
    return adaptSingle(
      await appApi.patch<AppApiSingle<Conversation>>(`/conversations/${id}/snooze`, {
        snoozedUntil: until.toISOString(),
        status: 'snoozed',
      }),
    );
  },

  /**
   * Add tags to a conversation
   */
  async addConversationTags(id: string, tags: string[]): Promise<ConversationResponse> {
    return adaptSingle(
      await appApi.patch<AppApiSingle<Conversation>>(`/conversations/${id}/tags`, { tags, action: 'add' }),
    );
  },

  /**
   * Remove tag from a conversation
   */
  async removeConversationTag(id: string, tag: string): Promise<ConversationResponse> {
    return adaptSingle(
      await appApi.patch<AppApiSingle<Conversation>>(`/conversations/${id}/tags`, { tag, action: 'remove' }),
    );
  },

  /**
   * Convert conversation to ticket
   *
   * Server-side, not two client calls: the ticket carries fields across from the
   * conversation (contact, channel, department, tags, assignee) and the
   * conversation is annotated with the link — the same path
   * `createTicket({ conversationId })` takes.
   */
  async convertConversationToTicket(id: string, ticketData?: {
    subject?: string;
    priority?: string;
    assigneeId?: string;
  }): Promise<{ success: boolean; data: Ticket }> {
    return adaptSingle(
      await appApi.post<AppApiSingle<Ticket>>(`/conversations/${id}/convert-to-ticket`, ticketData || {}),
    );
  },

  /**
   * Search customers (uses CRM customers endpoint)
   */
  async searchContacts(query: string): Promise<{ success: boolean; data: Helpdesk.Api.Contact[] }> {
    const res = await appApi.get<AppApiList<Helpdesk.Api.Contact>>(
      `/helpdesk-contacts${buildQueryString({ search: query, limit: 10 })}`,
    );
    return { success: true, data: res.data };
  },

  // -------------------------------------------------------------------------
  // Knowledge Base Articles
  // -------------------------------------------------------------------------

  /**
   * List articles
   */
  async listArticles(filters: {
    page?: number;
    pageSize?: number;
    search?: string;
    status?: string;
    folderId?: string;
  } = {}) {
    const res = await appApi.get<AppApiList<Helpdesk.Article>>(`/articles${listQuery(filters)}`);
    return adaptList(res, filters.page, filters.pageSize);
  },

  /**
   * Get an article by ID
   */
  async getArticle(id: string) {
    return adaptSingle(await appApi.get<AppApiSingle<Helpdesk.Article>>(`/articles/${id}`));
  },

  /**
   * Create an article
   */
  async createArticle(data: {
    title: string;
    content: string;
    contentHtml?: string;
    folderId?: string;
    status?: 'draft' | 'published';
    tags?: string[];
  }) {
    return adaptSingle(await appApi.post<AppApiSingle<Helpdesk.Article>>('/articles', data));
  },

  /**
   * Update an article
   */
  async updateArticle(id: string, data: {
    title?: string;
    content?: string;
    contentHtml?: string;
    folderId?: string;
    status?: 'draft' | 'published';
    tags?: string[];
  }) {
    return adaptSingle(await appApi.patch<AppApiSingle<Helpdesk.Article>>(`/articles/${id}`, data));
  },

  /**
   * Delete an article
   */
  async deleteArticle(id: string) {
    await appApi.delete(`/articles/${id}`);
    return { success: true };
  },

  // -------------------------------------------------------------------------
  // Knowledge Base Folders
  // -------------------------------------------------------------------------

  /**
   * List folders
   */
  async listFolders() {
    const res = await appApi.get<AppApiList<{
      id: string;
      name: string;
      parentId?: string;
      sortOrder: number;
    }>>('/article-folders');
    return { success: true, data: res.data };
  },

  /**
   * Create a folder
   */
  async createFolder(data: {
    name: string;
    parentId?: string;
    sortOrder?: number;
  }) {
    return adaptSingle(
      await appApi.post<AppApiSingle<{ id: string; name: string; parentId?: string }>>('/article-folders', data),
    );
  },

  /**
   * Delete a folder
   */
  async deleteFolder(id: string) {
    await appApi.delete(`/article-folders/${id}`);
    return { success: true };
  },

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  /**
   * Get helpdesk statistics
   */
  async getStats() {
    return adaptSingle(
      await appApi.get<AppApiSingle<{
        totalTickets: number;
        openTickets: number;
        pendingTickets: number;
        resolvedTickets: number;
        closedTickets: number;
        avgResponseTime?: number;
        avgResolutionTime?: number;
      }>>('/helpdesk-stats'),
    );
  },

  /**
   * Reopen a ticket
   */
  async reopenTicket(id: string) {
    await appApi.patch(`/tickets/${id}`, { status: 'open' });
    return { success: true };
  },

  /**
   * Publish an article
   */
  async publishArticle(id: string) {
    return adaptSingle(await appApi.patch<AppApiSingle<Helpdesk.Article>>(`/articles/${id}`, { status: 'published' }));
  },

  /**
   * Archive an article
   */
  async archiveArticle(id: string) {
    return adaptSingle(await appApi.patch<AppApiSingle<Helpdesk.Article>>(`/articles/${id}`, { status: 'archived' }));
  },

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  /**
   * List agents
   *
   * Note: app-api's `/api/helpdesk-agents` defaults to a 25-row page where
   * api-worker defaulted to 20. Callers that pass no `pageSize` therefore see
   * up to 5 more agents than before — a superset, not a changed result set.
   */
  async listAgents(filters: {
    page?: number;
    pageSize?: number;
    departmentId?: string;
    status?: string;
    search?: string;
  } = {}) {
    const res = await appApi.get<AppApiList<HelpdeskAgentRecord>>(`/helpdesk-agents${listQuery(filters)}`);
    return adaptList(res, filters.page, filters.pageSize);
  },

  /**
   * Get an agent by ID
   */
  async getAgent(id: string) {
    return adaptSingle(
      await appApi.get<AppApiSingle<HelpdeskAgentRecord>>(`/helpdesk-agents/${id}`),
    );
  },

  /**
   * Create an agent
   */
  async createAgent(data: {
    userId: string;
    name: string;
    email: string;
    role?: string;
    departmentId?: string;
    status?: string;
    availability?: string;
    maxActiveTickets?: number;
    skills?: string[];
    languages?: string[];
  }) {
    return adaptSingle(
      await appApi.post<AppApiSingle<{ id: string; name: string; email: string; role: string; createdAt: string }>>(
        '/helpdesk-agents',
        data,
      ),
    );
  },

  /**
   * Update an agent
   */
  async updateAgent(id: string, data: {
    name?: string;
    email?: string;
    role?: string;
    departmentId?: string;
    status?: string;
    availability?: string;
    maxActiveTickets?: number;
    skills?: string[];
    languages?: string[];
  }) {
    return adaptSingle(await appApi.patch<AppApiSingle<HelpdeskAgentRecord>>(`/helpdesk-agents/${id}`, data));
  },

  /**
   * Delete an agent
   */
  async deleteAgent(id: string) {
    await appApi.delete(`/helpdesk-agents/${id}`);
    return { success: true };
  },

  /**
   * Update agent status
   */
  async updateAgentStatus(id: string, status: string) {
    return adaptSingle(await appApi.patch<AppApiSingle<HelpdeskAgentRecord>>(`/helpdesk-agents/${id}`, { status }));
  },

  /**
   * Get tickets assigned to an agent
   */
  async getAgentTickets(agentId: string, filters: { page?: number; pageSize?: number } = {}) {
    const res = await appApi.get<AppApiList<Ticket>>(
      `/tickets${listQuery(filters, { assigneeId: agentId })}`,
    );
    return adaptList(res, filters.page, filters.pageSize);
  },

  // -------------------------------------------------------------------------
  // Departments
  // -------------------------------------------------------------------------

  /**
   * List departments
   *
   * Ordered by `sortOrder` (the order the teams were arranged in), not by
   * `createdAt`. `agentCount` is computed server-side from the agent roster —
   * it is not a column.
   */
  async listDepartments(filters: {
    page?: number;
    pageSize?: number;
    isActive?: boolean;
  } = {}) {
    const res = await appApi.get<AppApiList<HelpdeskDepartmentRecord>>(
      `/helpdesk-departments${listQuery(filters)}`,
    );
    return adaptList(res, filters.page, filters.pageSize);
  },

  /**
   * Get a department by ID
   */
  async getDepartment(id: string) {
    return adaptSingle(
      await appApi.get<AppApiSingle<HelpdeskDepartmentRecord>>(`/helpdesk-departments/${id}`),
    );
  },

  /**
   * Create a department
   */
  async createDepartment(data: {
    name: string;
    description?: string;
    email?: string;
    managerId?: string;
    autoAssignment?: boolean;
    roundRobinAssignment?: boolean;
    categories?: string[];
    defaultPriority?: string;
    isActive?: boolean;
  }) {
    return adaptSingle(
      await appApi.post<AppApiSingle<{ id: string; name: string; isActive: boolean; createdAt: string }>>(
        '/helpdesk-departments',
        data,
      ),
    );
  },

  /**
   * Update a department
   */
  async updateDepartment(id: string, data: {
    name?: string;
    description?: string;
    email?: string;
    managerId?: string;
    autoAssignment?: boolean;
    roundRobinAssignment?: boolean;
    categories?: string[];
    defaultPriority?: string;
    isActive?: boolean;
  }) {
    return adaptSingle(await appApi.patch<AppApiSingle<HelpdeskDepartmentRecord>>(`/helpdesk-departments/${id}`, data));
  },

  /**
   * Delete a department
   */
  async deleteDepartment(id: string) {
    await appApi.delete(`/helpdesk-departments/${id}`);
    return { success: true };
  },

  // -------------------------------------------------------------------------
  // FAQs
  // -------------------------------------------------------------------------

  /**
   * List FAQs
   */
  async listFAQs(filters: { page?: number; pageSize?: number; category?: string } = {}) {
    const res = await appApi.get<AppApiList<Helpdesk.FAQ>>(`/helpdesk-faqs${listQuery(filters)}`);
    return adaptList(res, filters.page, filters.pageSize);
  },

  /**
   * Create a FAQ
   */
  async createFAQ(data: {
    question: string;
    answer: string;
    answerHtml?: string;
    categoryId?: string;
    sortOrder?: number;
    isPublished?: boolean;
  }) {
    return adaptSingle(await appApi.post<AppApiSingle<Helpdesk.FAQ>>('/helpdesk-faqs', data));
  },

  // -------------------------------------------------------------------------
  // Canned Responses
  // -------------------------------------------------------------------------

  /**
   * List canned responses
   */
  async listCannedResponses(filters: {
    page?: number;
    pageSize?: number;
    category?: string;
    scope?: string;
    search?: string;
    isActive?: boolean;
    agentId?: string;
    departmentId?: string;
  } = {}) {
    const res = await appApi.get<AppApiList<CannedResponse>>(`/canned-responses${listQuery(filters)}`);
    return adaptList(res, filters.page, filters.pageSize);
  },

  /**
   * Get a single canned response
   */
  async getCannedResponse(id: string) {
    return adaptSingle(await appApi.get<AppApiSingle<CannedResponse>>(`/canned-responses/${id}`));
  },

  /**
   * Create a canned response
   */
  async createCannedResponse(data: {
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
  }) {
    return adaptSingle(
      await appApi.post<AppApiSingle<{ id: string; name: string }>>('/canned-responses', data),
    );
  },

  /**
   * Update a canned response
   */
  async updateCannedResponse(id: string, data: {
    name?: string;
    subject?: string;
    content?: string;
    category?: string;
    scope?: 'personal' | 'team' | 'department' | 'global';
    agentId?: string;
    teamId?: string;
    departmentId?: string;
    shortcut?: string;
    keywords?: string[];
    actions?: Array<{ type: string; value: unknown }>;
    isActive?: boolean;
  }) {
    return adaptSingle(await appApi.patch<AppApiSingle<{ id: string }>>(`/canned-responses/${id}`, data));
  },

  /**
   * Delete a canned response
   */
  async deleteCannedResponse(id: string) {
    await appApi.delete(`/canned-responses/${id}`);
    return { success: true };
  },

  /**
   * Use a canned response (render with variables + increment usage)
   */
  async useCannedResponse(id: string, variables: Record<string, unknown> = {}) {
    return adaptSingle(
      await appApi.post<AppApiSingle<{
        content: string;
        subject: string | null;
        actions: Array<{ type: string; value: unknown }>;
      }>>(`/canned-responses/${id}/use`, { variables }),
    );
  },

  /**
   * Get distinct canned response categories
   */
  async getCannedResponseCategories() {
    return adaptSingle(await appApi.get<AppApiSingle<string[]>>('/canned-responses/categories'));
  },

  /**
   * Search canned responses (lightweight for picker)
   */
  async searchCannedResponses(q: string, limit?: number) {
    return adaptSingle(
      await appApi.get<AppApiSingle<CannedResponse[]>>(`/canned-responses/search${buildQueryString({ q, limit })}`),
    );
  },

  // -------------------------------------------------------------------------
  // Contacts (uses CRM contacts endpoint)
  // -------------------------------------------------------------------------

  /**
   * List contacts (uses the helpdesk contacts endpoint)
   */
  async listHelpdeskContacts(filters: { page?: number; pageSize?: number; search?: string } = {}) {
    const res = await appApi.get<AppApiList<Helpdesk.Api.Contact>>(`/helpdesk-contacts${listQuery(filters)}`);
    return adaptList(res, filters.page, filters.pageSize);
  },

  /**
   * Create a contact (uses the helpdesk contacts endpoint)
   */
  async createHelpdeskContact(data: {
    name?: string;
    email?: string;
    phone?: string;
    company?: string;
    avatarUrl?: string;
    notes?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }) {
    return adaptSingle(
      await appApi.post<AppApiSingle<Helpdesk.Api.Contact>>('/helpdesk-contacts', {
        firstName: data.name?.split(' ')[0] || '',
        lastName: data.name?.split(' ').slice(1).join(' ') || '',
        email: data.email,
        directPhone: data.phone,
        notes: data.notes,
        status: 'active',
      }),
    );
  },

  // -------------------------------------------------------------------------
  // Announcements
  // -------------------------------------------------------------------------

  /**
   * List announcements
   */
  async listAnnouncements(filters: { page?: number; pageSize?: number } = {}) {
    const res = await appApi.get<AppApiList<Helpdesk.Api.Announcement>>(`/helpdesk-announcements${listQuery(filters)}`);
    return adaptList(res, filters.page, filters.pageSize);
  },

  /**
   * Create an announcement
   */
  async createAnnouncement(data: {
    title: string;
    content: string;
    htmlContent?: string;
    type?: string;
    status?: string;
    targetAudience?: string;
    publishedAt?: string;
    expiresAt?: string;
  }) {
    return adaptSingle(await appApi.post<AppApiSingle<Helpdesk.Api.Announcement>>('/helpdesk-announcements', data));
  },

  // -------------------------------------------------------------------------
  // Changelog
  // -------------------------------------------------------------------------

  /**
   * List changelog entries
   */
  async listChangelog(filters: { page?: number; pageSize?: number } = {}) {
    const res = await appApi.get<AppApiList<Helpdesk.Api.ChangelogEntry>>(`/helpdesk-changelog${listQuery(filters)}`);
    return adaptList(res, filters.page, filters.pageSize);
  },

  // -------------------------------------------------------------------------
  // News
  // -------------------------------------------------------------------------

  /**
   * List news items
   *
   * Note: app-api's `/api/helpdesk-news` returns no `stats` block, so the
   * `stats` field this contract advertises is absent at runtime. No caller
   * reads it today.
   */
  async listNews(filters: {
    page?: number;
    pageSize?: number;
    search?: string;
    category?: string;
    status?: 'draft' | 'published' | 'archived';
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  } = {}) {
    const res = await appApi.get<AppApiList<HelpdeskNewsRecord>>(`/helpdesk-news${listQuery(filters)}`);
    return adaptList(res, filters.page, filters.pageSize);
  },

  /**
   * Get a single news article
   */
  async getNews(id: string) {
    return adaptSingle(
      await appApi.get<AppApiSingle<HelpdeskNewsRecord>>(`/helpdesk-news/${id}`),
    );
  },

  /**
   * Create a news item
   */
  async createNews(data: {
    title: string;
    content: string;
    excerpt?: string;
    category?: string;
    tags?: string[];
    featuredImage?: string;
    status?: 'draft' | 'published' | 'archived';
    isPinned?: boolean;
  }) {
    return adaptSingle(
      await appApi.post<AppApiSingle<{ id: string; title: string; status: string; createdAt: string }>>(
        '/helpdesk-news',
        data,
      ),
    );
  },

  /**
   * Update a news item
   */
  async updateNews(id: string, data: {
    title?: string;
    content?: string;
    excerpt?: string;
    category?: string;
    tags?: string[];
    featuredImage?: string;
    status?: 'draft' | 'published' | 'archived';
    isPinned?: boolean;
  }) {
    return adaptSingle(await appApi.patch<AppApiSingle<HelpdeskNewsRecord>>(`/helpdesk-news/${id}`, data));
  },

  /**
   * Delete a news item
   */
  async deleteNews(id: string) {
    await appApi.delete(`/helpdesk-news/${id}`);
    return { success: true };
  },

  // -------------------------------------------------------------------------
  // Feedback
  // -------------------------------------------------------------------------

  /**
   * List feedback items
   */
  async listFeedback(filters: { page?: number; pageSize?: number } = {}) {
    const res = await appApi.get<AppApiList<Helpdesk.Api.FeedbackItem>>(`/helpdesk-feedback${listQuery(filters)}`);
    return adaptList(res, filters.page, filters.pageSize);
  },

  /**
   * Create a feedback item
   */
  async createFeedback(data: {
    title?: string;
    content: string;
    type?: string;
    status?: string;
    submittedById?: string;
    submittedByName?: string;
    submittedByEmail?: string;
  }) {
    return adaptSingle(await appApi.post<AppApiSingle<Helpdesk.Api.FeedbackItem>>('/helpdesk-feedback', data));
  },

  // -------------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------------

  /**
   * List reviews (from ticket satisfaction ratings)
   *
   * Note: app-api's `/api/helpdesk-reviews` returns no `stats` block, so the
   * `stats` field this contract advertises is absent at runtime. No caller
   * reads it today.
   */
  async listReviews(filters: {
    page?: number;
    pageSize?: number;
    search?: string;
    sentiment?: 'positive' | 'neutral' | 'negative';
    source?: string;
    status?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  } = {}) {
    const res = await appApi.get<AppApiList<{
      id: string;
      customerName: string;
      customerEmail: string;
      rating: number;
      comment: string;
      date: string;
      source: string;
      status: string;
      sentiment: 'positive' | 'neutral' | 'negative';
      agentName?: string;
      ticketId?: string;
      conversationId?: string;
      helpful: number;
      notHelpful: number;
    }>>(`/helpdesk-reviews${listQuery(filters)}`);
    return adaptList(res, filters.page, filters.pageSize);
  },

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  /**
   * Get helpdesk settings
   */
  async getSettings() {
    return adaptSingle(
      await appApi.get<AppApiSingle<{
        settings: {
          id: string;
          general?: Helpdesk.Api.HelpdeskSettings['general'];
          tickets?: Helpdesk.Api.HelpdeskSettings['tickets'];
          notifications?: {
            emailNotifications: boolean;
            pushNotifications: boolean;
            smsNotifications: boolean;
            notifyOnNewTicket?: boolean;
            notifyOnAssignment?: boolean;
            notifyOnStatusChange?: boolean;
            notifyOnCustomerReply?: boolean;
            notifyOnSLABreach?: boolean;
          };
          satisfaction?: Helpdesk.Api.HelpdeskSettings['satisfaction'];
          integrations?: Helpdesk.Api.HelpdeskSettings['integrations'];
          customization?: Helpdesk.Api.HelpdeskSettings['customization'];
          createdAt?: string;
          updatedAt?: string;
        } | null;
        widgetSettings: {
          id: string;
          pageChat?: boolean;
          pageHome?: boolean;
          pageHelp?: boolean;
          name?: string;
          createdAt?: string;
          updatedAt?: string;
        } | null;
      }>>('/helpdesk-settings'),
    );
  },

  /**
   * Update notification settings
   */
  async updateNotificationSettings(data: {
    emailNotifications: boolean;
    pushNotifications: boolean;
    smsNotifications: boolean;
    notifyOnNewTicket?: boolean;
    notifyOnAssignment?: boolean;
    notifyOnStatusChange?: boolean;
    notifyOnCustomerReply?: boolean;
    notifyOnSLABreach?: boolean;
  }) {
    return adaptSingle(
      await appApi.put<AppApiSingle<{ success: boolean }>>('/helpdesk-settings/notifications', data),
    );
  },

  /**
   * Update widget settings
   */
  async updateWidgetSettings(data: {
    pageChat?: boolean;
    pageHome?: boolean;
    pageHelp?: boolean;
    name?: string;
  }) {
    return adaptSingle(
      await appApi.put<AppApiSingle<{ success: boolean; id: string }>>('/helpdesk-settings/widget', data),
    );
  },

  /**
   * Toggle widget enabled status
   */
  async updateWidgetEnabled(enabled: boolean) {
    return adaptSingle(
      await appApi.patch<AppApiSingle<{ success: boolean; id: string }>>(
        '/helpdesk-settings/widget/enabled',
        { enabled },
      ),
    );
  },

  // -------------------------------------------------------------------------
  // Users (for team member selection)
  // -------------------------------------------------------------------------

  /**
   * Fetch workspace users for team member selection
   */
  async listUsers() {
    // Use agents as users since they're the same in this context
    const response = await appApi.get<AppApiList<{
      id: string;
      userId: string;
      name: string;
      email: string;
    }>>('/helpdesk-agents');

    return {
      success: true,
      data: response.data.map((agent) => ({
        id: agent.userId || agent.id,
        name: agent.name,
        email: agent.email,
      })),
    };
  },

  // -------------------------------------------------------------------------
  // Widget Settings (Full)
  // -------------------------------------------------------------------------

  /**
   * Get widget settings
   */
  async getWidgetSettings() {
    return adaptSingle(
      await appApi.get<AppApiSingle<{
        id: string;
        widgetId?: string;
        widgetName?: string;
        pageHome?: boolean;
        pageChat?: boolean;
        pageHelp?: boolean;
        pageParcelTracking?: boolean;
        pageChangelog?: boolean;
        pageNews?: boolean;
        pageFeedback?: boolean;
        pageAnnouncements?: boolean;
        pageEventSignUp?: boolean;
        colorPrimary?: string;
        colorButton?: string;
        colorButtonText?: string;
        colorLauncher?: string;
        colorHeader?: string;
        colorAccent?: string;
        borderRadius?: string;
        fontSize?: string;
        typographyText?: string;
        typographyBackground?: string;
        startingPage?: string;
        position?: string;
        autoOpen?: boolean;
        showWelcomeMessage?: boolean;
        welcomeMessage?: string;
        companyLogoUrl?: string;
        chatBackgroundColor?: string;
        userBubbleColor?: string;
        userBubbleTextColor?: string;
        agentBubbleColor?: string;
        agentBubbleTextColor?: string;
      } | null>>('/helpdesk-settings/widget'),
    );
  },

  /**
   * Upsert widget settings
   */
  async upsertWidgetSettings(data: {
    widgetName?: string;
    pageHome?: boolean;
    pageChat?: boolean;
    pageHelp?: boolean;
    pageParcelTracking?: boolean;
    pageChangelog?: boolean;
    pageNews?: boolean;
    pageFeedback?: boolean;
    pageAnnouncements?: boolean;
    pageEventSignUp?: boolean;
    colorPrimary?: string;
    colorButton?: string;
    colorButtonText?: string;
    colorLauncher?: string;
    colorHeader?: string;
    colorAccent?: string;
    borderRadius?: string;
    fontSize?: string;
    typographyText?: string;
    typographyBackground?: string;
    startingPage?: string;
    position?: string;
    autoOpen?: boolean;
    showWelcomeMessage?: boolean;
    welcomeMessage?: string;
    companyLogoUrl?: string;
    chatBackgroundColor?: string;
    userBubbleColor?: string;
    userBubbleTextColor?: string;
    agentBubbleColor?: string;
    agentBubbleTextColor?: string;
  }) {
    return adaptSingle(
      await appApi.put<AppApiSingle<{
        id: string;
        widgetId?: string;
        widgetName?: string;
        workspaceId?: string;
        isNew?: boolean;
      }>>('/helpdesk-settings/widget', data),
    );
  },

  // -------------------------------------------------------------------------
  // Multi-Widget Management
  // -------------------------------------------------------------------------

  /**
   * List all widgets for the workspace
   */
  async listWidgets() {
    const res = await appApi.get<AppApiSingle<Array<{
      id: string;
      widgetId: string;
      widgetName?: string;
      pageHome?: boolean;
      pageChat?: boolean;
      pageHelp?: boolean;
      pageParcelTracking?: boolean;
      pageChangelog?: boolean;
      pageNews?: boolean;
      pageFeedback?: boolean;
      pageAnnouncements?: boolean;
      pageEventSignUp?: boolean;
      colorPrimary?: string;
      colorButton?: string;
      colorButtonText?: string;
      colorLauncher?: string;
      colorHeader?: string;
      colorAccent?: string;
      borderRadius?: string;
      fontSize?: string;
      typographyText?: string;
      typographyBackground?: string;
      startingPage?: string;
      position?: string;
      autoOpen?: boolean;
      showWelcomeMessage?: boolean;
      welcomeMessage?: string;
      companyLogoUrl?: string;
      showBranding?: boolean;
      chatBackgroundColor?: string;
      userBubbleColor?: string;
      userBubbleTextColor?: string;
      agentBubbleColor?: string;
      agentBubbleTextColor?: string;
      createdAt?: string;
      updatedAt?: string;
    }>>>('/helpdesk-settings/widgets');
    return adaptSingle(res);
  },

  /**
   * Get a specific widget by widgetId
   */
  async getWidgetById(widgetId: string) {
    return adaptSingle(
      await appApi.get<AppApiSingle<{
        id: string;
        widgetId: string;
        widgetName?: string;
        pageHome?: boolean;
        pageChat?: boolean;
        pageHelp?: boolean;
        pageParcelTracking?: boolean;
        pageChangelog?: boolean;
        pageNews?: boolean;
        pageFeedback?: boolean;
        pageAnnouncements?: boolean;
        pageEventSignUp?: boolean;
        colorPrimary?: string;
        colorButton?: string;
        colorButtonText?: string;
        colorLauncher?: string;
        colorHeader?: string;
        colorAccent?: string;
        borderRadius?: string;
        fontSize?: string;
        typographyText?: string;
        typographyBackground?: string;
        startingPage?: string;
        position?: string;
        autoOpen?: boolean;
        showWelcomeMessage?: boolean;
        welcomeMessage?: string;
        companyLogoUrl?: string;
        showBranding?: boolean;
        chatBackgroundColor?: string;
        userBubbleColor?: string;
        userBubbleTextColor?: string;
        agentBubbleColor?: string;
        agentBubbleTextColor?: string;
        createdAt?: string;
        updatedAt?: string;
      }>>(`/helpdesk-settings/widgets/${widgetId}`),
    );
  },

  /**
   * Create a new widget
   */
  async createWidget(data: {
    widgetName?: string;
    pageHome?: boolean;
    pageChat?: boolean;
    pageHelp?: boolean;
  }) {
    return adaptSingle(
      await appApi.post<AppApiSingle<{ id: string; widgetId: string; widgetName: string }>>(
        '/helpdesk-settings/widgets',
        data,
      ),
    );
  },

  /**
   * Update a specific widget by widgetId
   */
  async updateWidgetById(widgetId: string, data: {
    widgetName?: string;
    pageHome?: boolean;
    pageChat?: boolean;
    pageHelp?: boolean;
    pageParcelTracking?: boolean;
    pageChangelog?: boolean;
    pageNews?: boolean;
    pageFeedback?: boolean;
    pageAnnouncements?: boolean;
    pageEventSignUp?: boolean;
    colorPrimary?: string;
    colorButton?: string;
    colorButtonText?: string;
    colorLauncher?: string;
    colorHeader?: string;
    colorAccent?: string;
    borderRadius?: string;
    fontSize?: string;
    typographyText?: string;
    typographyBackground?: string;
    startingPage?: string;
    position?: string;
    autoOpen?: boolean;
    showWelcomeMessage?: boolean;
    welcomeMessage?: string;
    companyLogoUrl?: string;
    showBranding?: boolean;
    chatBackgroundColor?: string;
    userBubbleColor?: string;
    userBubbleTextColor?: string;
    agentBubbleColor?: string;
    agentBubbleTextColor?: string;
  }) {
    return adaptSingle(
      await appApi.put<AppApiSingle<{ id: string; widgetId: string; widgetName?: string }>>(
        `/helpdesk-settings/widgets/${widgetId}`,
        data,
      ),
    );
  },

  /**
   * Delete a widget by widgetId (soft-delete)
   */
  async deleteWidget(widgetId: string) {
    await appApi.delete(`/helpdesk-settings/widgets/${widgetId}`);
    return { success: true, data: { success: true } };
  },

  // -------------------------------------------------------------------------
  // Announcements (Extended)
  // -------------------------------------------------------------------------

  /**
   * Get a single announcement
   */
  async getAnnouncement(id: string) {
    return adaptSingle(await appApi.get<AppApiSingle<Helpdesk.Api.Announcement>>(`/helpdesk-announcements/${id}`));
  },

  /**
   * Update an announcement
   */
  async updateAnnouncement(id: string, data: {
    title?: string;
    content?: string;
    htmlContent?: string;
    type?: string;
    status?: string;
    targetAudience?: string;
    publishedAt?: string;
    expiresAt?: string;
  }) {
    return adaptSingle(await appApi.patch<AppApiSingle<Helpdesk.Api.Announcement>>(`/helpdesk-announcements/${id}`, data));
  },

  /**
   * Delete an announcement
   */
  async deleteAnnouncement(id: string) {
    await appApi.delete(`/helpdesk-announcements/${id}`);
    return { success: true };
  },

  /**
   * Publish an announcement
   */
  async publishAnnouncement(id: string) {
    return adaptSingle(
      await appApi.patch<AppApiSingle<Helpdesk.Api.Announcement>>(`/helpdesk-announcements/${id}`, { status: 'published' }),
    );
  },

  // -------------------------------------------------------------------------
  // Analytics Reports
  // -------------------------------------------------------------------------

  /**
   * List analytics reports
   */
  async listAnalyticsReports(filters: { page?: number; pageSize?: number } = {}) {
    // app-api returns a bare `{ data: Report[] }` here — no pagination block.
    const res = await appApi.get<AppApiSingle<HelpdeskAnalyticsReportRecord[]>>(
      `/helpdesk-analytics${listQuery(filters)}`,
    );
    return adaptArrayAsList(res, filters.page, filters.pageSize);
  },

  /**
   * Get a single analytics report
   */
  async getAnalyticsReport(id: string) {
    return adaptSingle(
      await appApi.get<AppApiSingle<HelpdeskAnalyticsReportRecord>>(`/helpdesk-analytics/reports/${id}`),
    );
  },

  /**
   * Create an analytics report
   */
  async createAnalyticsReport(data: {
    title: string;
    description?: string;
  }) {
    return adaptSingle(
      await appApi.post<AppApiSingle<HelpdeskAnalyticsReportRecord>>('/helpdesk-analytics', data),
    );
  },

  /**
   * Update an analytics report
   */
  async updateAnalyticsReport(id: string, data: {
    title?: string;
    description?: string;
  }) {
    return adaptSingle(await appApi.patch<AppApiSingle<HelpdeskAnalyticsReportRecord>>(`/helpdesk-analytics/${id}`, data));
  },

  /**
   * Delete an analytics report
   */
  async deleteAnalyticsReport(id: string) {
    await appApi.delete(`/helpdesk-analytics/${id}`);
    return { success: true };
  },

  /**
   * Duplicate an analytics report
   */
  async duplicateAnalyticsReport(id: string) {
    return adaptSingle(
      await appApi.post<AppApiSingle<HelpdeskAnalyticsReportRecord>>(`/helpdesk-analytics/reports/${id}/duplicate`, {}),
    );
  },

  // -------------------------------------------------------------------------
  // Analytics Charts
  // -------------------------------------------------------------------------

  /**
   * List charts for a report
   */
  async listAnalyticsCharts(reportId: string) {
    const res = await appApi.get<AppApiSingle<HelpdeskAnalyticsChartRecord[]>>(
      `/helpdesk-analytics/reports/${reportId}/charts`,
    );
    return adaptSingle(res);
  },

  /**
   * Get a single chart
   */
  async getAnalyticsChart(chartId: string) {
    return adaptSingle(await appApi.get<AppApiSingle<HelpdeskAnalyticsChartRecord>>(`/helpdesk-analytics/charts/${chartId}`));
  },

  /**
   * Create an analytics chart
   */
  async createAnalyticsChart(data: {
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
    layout?: HelpdeskChartLayout;
  }) {
    return adaptSingle(await appApi.post<AppApiSingle<HelpdeskAnalyticsChartRecord>>('/helpdesk-analytics/charts', data));
  },

  /**
   * Update an analytics chart
   */
  async updateAnalyticsChart(chartId: string, data: {
    title?: string;
    description?: string;
    chartType?: string;
    entity?: string;
    metric?: string;
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
    layout?: HelpdeskChartLayout;
  }) {
    return adaptSingle(await appApi.put<AppApiSingle<HelpdeskAnalyticsChartRecord>>(`/helpdesk-analytics/charts/${chartId}`, data));
  },

  /**
   * Delete an analytics chart
   */
  async deleteAnalyticsChart(chartId: string) {
    await appApi.delete(`/helpdesk-analytics/charts/${chartId}`);
    return { success: true };
  },

  /**
   * Update multiple chart layouts
   */
  async updateAnalyticsChartLayouts(reportId: string, layouts: Array<{ chartId: string; layout: HelpdeskChartLayout }>) {
    await appApi.patch(`/helpdesk-analytics/reports/${reportId}/layouts`, { layouts });
    return { success: true };
  },

  /**
   * Get chart data for a single chart
   */
  async getAnalyticsChartData(chartConfig: {
    entity: string;
    metric: string;
    timeRange: string;
    groupBy: string;
    aggregation: string;
    sortOrder?: string;
    limit?: number;
  }) {
    return adaptSingle(
      await appApi.post<AppApiSingle<Array<{ label: string; value: number; date?: string }>>>(
        '/helpdesk-analytics/charts/data',
        chartConfig,
      ),
    );
  },

  /**
   * Get chart data for multiple charts (batch)
   */
  async getAnalyticsChartsData(charts: Array<{
    chartId: string;
    entity: string;
    metric: string;
    timeRange: string;
    groupBy: string;
    aggregation: string;
    sortOrder?: string;
    limit?: number;
  }>) {
    return adaptSingle(
      await appApi.post<AppApiSingle<Record<string, Array<{ label: string; value: number; date?: string }>>>>(
        '/helpdesk-analytics/charts/batch-data',
        { charts },
      ),
    );
  },

  // ============================================================================
  // Email Address Management
  // ============================================================================

  async getHelpdeskEmailAddresses() {
    return adaptSingle(
      await appApi.get<AppApiSingle<Array<{
        id: string;
        email: string;
        accountId: string;
        isActive: boolean;
        createdAt: string;
      }>>>('/helpdesk-email/addresses'),
    );
  },

  async createHelpdeskEmailAddress(email: string) {
    return adaptSingle(
      await appApi.post<AppApiSingle<{
        id: string;
        email: string;
        accountId: string;
        isActive: boolean;
      }>>('/helpdesk-email/addresses', { email }),
    );
  },

  async deleteHelpdeskEmailAddress(id: string) {
    return adaptSingle(
      await appApi.delete<AppApiSingle<{ id: string; isActive: boolean }>>(`/helpdesk-email/addresses/${id}`),
    );
  },

  async getHelpdeskAvailableDomains() {
    return adaptSingle(
      await appApi.get<AppApiSingle<Array<{
        id: string;
        domainName: string;
        dnsStatus: string;
        isActive: boolean;
      }>>>('/helpdesk-email/domains'),
    );
  },
};
