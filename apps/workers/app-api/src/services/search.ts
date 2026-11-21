/**
 * Federated Search Service
 *
 * Per-entity search functions + an orchestrator that fans out and merges results.
 * Tenant isolation is enforced by the per-tenant DB itself; every function still
 * takes the workspaceId so callers cannot accidentally hit a wrong tenant.
 *
 * v1: ILIKE-based matching with rule-based scoring. No DB migrations required.
 * v1.5 (deferred): pg_trgm GIN indexes + similarity() ranking.
 *
 * Ported from apps/core-api/src/routes/search.ts + services/search*.ts during the
 * core-api → app-api migration. Result-URL mapping is folded in below.
 */

import { and, desc, eq, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import {
  loadDriveAccessForUser,
  visibleFilesCondition,
  type DriveAccessIndex,
} from '@weldsuite/core-domain/drive-access';
import { agentVisibleTo } from '@weldsuite/core-domain/agent-access';
import {
  type SearchEntityType,
  type SearchResultGroup,
  type SearchResultItem,
} from '@weldsuite/app-api-client/schemas/search';
import { publicDomainRegistrar } from '@weldsuite/core-api-client/schemas/domains';

// ============================================================================
// Types
// ============================================================================

export interface PermissionLike {
  hasAny: (permissions: string[]) => boolean;
}

export interface RunSearchParams {
  q: string;
  types?: SearchEntityType[];
  limit: number;
  perms: PermissionLike;
  /**
   * The string the per-entity `ILIKE` queries should actually match on, once
   * type nouns and function words have been stripped by
   * `services/search/query-understanding.ts`.
   *
   * "Invoice from Acme Corp" arrives as `q`, but matching that whole sentence
   * against `invoices.contactName` returns nothing — the column holds "Acme
   * Corp". Defaults to `q`, so callers that don't structure the query keep the
   * original behaviour exactly.
   */
  lexicalTerm?: string;
  /**
   * Who is searching. Records that are visible per person rather than per
   * workspace (Drive files follow WeldDrive sharing, forms, meetings, signature
   * requests, channels and agents their own rules) are filtered by it; with no
   * user (null or omitted) those types return nothing. Scope grants are read
   * through `perms`.
   */
  userId?: string | null;
}

/**
 * Who is searching, for the record types whose visibility is per person:
 * the user (null: no one, so those types return nothing) and a permission
 * check against the same any-app subject that gates the types themselves.
 * Scope grants (`weldmeet:meetings:scope:all`, `forms:manage`, ...) read
 * through `can`.
 */
export interface SearchCaller {
  userId: string | null;
  can: (permission: string) => boolean;
  /** The caller's WeldDrive access, loaded once for every Drive-backed type of one search. */
  driveAccess?: () => Promise<DriveAccessIndex>;
}

interface EntityRegistration {
  type: SearchEntityType;
  permission: string;
  search: (
    db: Database,
    workspaceId: string,
    q: string,
    limit: number,
    caller: SearchCaller,
  ) => Promise<SearchResultGroup>;
}

// Canonical group ordering for the response.
const CANONICAL_ORDER: SearchEntityType[] = [
  'contact',
  'customer',
  'lead',
  'opportunity',
  'ticket',
  'conversation',
  'article',
  'knowledge_page',
  'product',
  'warehouse',
  'invoice',
  'bill',
  'project',
  'task',
  'merge_issue',
  'merge_pull_request',
  'document',
  'sheet',
  'board',
  'form',
  'sign_envelope',
  'drive_file',
  'meeting',
  'chat_channel',
  'reach_campaign',
  'data_list',
  'panel_project',
  'workflow',
  'agent',
  'domain',
];

// ============================================================================
// Result-URL mapping
// ============================================================================

/**
 * Central map from search-result type → platform-relative URL.
 *
 * Keep this in sync with the file-based routes under apps/web/platform/src/routes.
 * Adding a new entity type to search means: implement the search function,
 * add a case here, and add the type to SEARCH_ENTITY_TYPES in
 * packages/clients/app-api-client/src/schemas/search.ts.
 *
 * CRM records have no detail routes. Companies and people open as object
 * panels, deep-linked from their list page with `?stack=<type>:<id>`
 * (components/object-panel/stack-url.ts). Leads and opportunities only have an
 * entity sheet, which the app shell opens over any page from
 * `?entity=<type>:<id>` (components/entity-sheet/url-param.ts).
 *
 * Helpdesk tickets have no route either: the WeldDesk inbox lists desk
 * conversations (a different table) and `/welddesk/*` falls through to it, so
 * a ticket opens as an entity sheet over the inbox. `/welddesk` itself
 * redirects to the inbox and drops the query, hence the explicit path.
 *
 * Products open as object panels on the WeldStash products list.
 *
 * Spreadsheets have a page of their own: `/weldsheets/:id`. So do documents
 * (`/welddocs/:id`), forms (`/weldforms/:id`, which opens the editor), desk
 * conversations, meetings, signature requests, workflows, agents, outreach
 * campaigns, chat channels, data lists and tracked projects. A Drive file has
 * none: WeldDrive opens it in the preview from `?file=<id>`, and a warehouse
 * opens as an object panel on its list page.
 */
/** Types whose record has a page of its own at `<path>/<id>`. */
const RECORD_PAGE = {
  article: '/welddesk/help-center/articles',
  knowledge_page: '/weldknow/page',
  invoice: '/weldbooks/invoices',
  bill: '/weldbooks/bills',
  project: '/weldflow/project',
  task: '/weldflow/task',
  sheet: '/weldsheets',
  board: '/weldboard',
  domain: '/weldhost/domains',
  document: '/welddocs',
  form: '/weldforms',
  conversation: '/welddesk/inbox',
  meeting: '/weldmeet',
  sign_envelope: '/weldsign',
  workflow: '/weldconnect/workflows',
  agent: '/agents',
  reach_campaign: '/weldreach/campaigns',
  chat_channel: '/weldchat',
  data_list: '/welddata/lists',
  panel_project: '/weldpanel/projects',
} as const satisfies Partial<Record<SearchEntityType, string>>;

function hasRecordPage(type: SearchEntityType): type is keyof typeof RECORD_PAGE {
  return type in RECORD_PAGE;
}

export function buildResultUrl(type: SearchEntityType, id: string): string {
  if (hasRecordPage(type)) return `${RECORD_PAGE[type]}/${id}`;
  switch (type) {
    case 'contact':
      return `/weldcrm/people?stack=person:${encodeURIComponent(id)}`;
    case 'customer':
      return `/weldcrm/companies?stack=company:${encodeURIComponent(id)}`;
    case 'lead':
      return `/weldcrm?entity=lead:${encodeURIComponent(id)}`;
    case 'opportunity':
      return `/weldcrm?entity=opportunity:${encodeURIComponent(id)}`;
    case 'ticket':
      return `/welddesk/inbox?entity=ticket:${encodeURIComponent(id)}`;
    case 'product':
      return `/weldstash/products?stack=product:${encodeURIComponent(id)}`;
    case 'merge_issue':
      return `/weldmerge/issues/${encodeURIComponent(id)}`;
    case 'merge_pull_request':
      return `/weldmerge/pull-requests/${encodeURIComponent(id)}`;
    case 'drive_file':
      return `/welddrive?file=${encodeURIComponent(id)}`;
    case 'warehouse':
      return `/weldstash/warehouses?stack=warehouse:${encodeURIComponent(id)}`;
    // WeldCommerce orders are searched by the Rust backend only (EU edition);
    // this search never returns them, the case keeps the type list complete.
    case 'order':
      return `/weldcommerce/orders?stack=order:${encodeURIComponent(id)}`;
  }
}

// ============================================================================
// Score Helpers (rule-based; switch to similarity() when pg_trgm lands)
// ============================================================================

function withSuffix(head: string, tail: string | null | undefined): string {
  return tail ? `${head} · ${tail}` : head;
}

/**
 * Build a CASE expression scoring a column against the query term.
 *  1.0 — exact match (case-insensitive)
 *  0.9 — prefix match
 *  0.6 — substring match
 *  0   — no match
 */
function scoreColumn(col: unknown, q: string) {
  const term = q.toLowerCase();
  return sql<number>`CASE
    WHEN lower(${col}) = ${term} THEN 1.0
    WHEN lower(${col}) LIKE ${term + '%'} THEN 0.9
    WHEN lower(${col}) LIKE ${'%' + term + '%'} THEN 0.6
    ELSE 0
  END`;
}

function emailScore(col: unknown, q: string) {
  const term = q.toLowerCase();
  return sql<number>`CASE
    WHEN lower(${col}) = ${term} THEN 1.0
    WHEN lower(${col}) LIKE ${term + '%'} THEN 0.7
    WHEN lower(${col}) LIKE ${'%' + term + '%'} THEN 0.3
    ELSE 0
  END`;
}

// ============================================================================
// Per-entity search functions
// ============================================================================

export async function searchContacts(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { people } = schema;
  const term = `%${q}%`;
  const score = sql<number>`GREATEST(
    ${scoreColumn(people.fullName, q)},
    ${scoreColumn(people.firstName, q)},
    ${scoreColumn(people.lastName, q)},
    ${emailScore(people.email, q)}
  )`;

  const rows = await db
    .select({
      id: people.id,
      firstName: people.firstName,
      lastName: people.lastName,
      fullName: people.fullName,
      email: people.email,
      title: people.title,
      score,
      updatedAt: people.updatedAt,
    })
    .from(people)
    .where(
      and(
        isNull(people.deletedAt),
        or(
          sql`lower(${people.fullName}) LIKE ${term.toLowerCase()}`,
          sql`lower(${people.firstName}) LIKE ${term.toLowerCase()}`,
          sql`lower(${people.lastName}) LIKE ${term.toLowerCase()}`,
          sql`lower(${people.email}) LIKE ${term.toLowerCase()}`,
        ),
      ),
    )
    .orderBy(desc(score), desc(people.updatedAt), desc(people.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => {
    const display =
      (r.fullName?.trim()) ||
      [r.firstName, r.lastName].filter(Boolean).join(' ').trim() ||
      r.email ||
      'Person';
    return {
      id: r.id,
      type: 'contact',
      title: display,
      subtitle: r.title || r.email || null,
      url: buildResultUrl('contact', r.id),
      score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
    };
  });

  return {
    type: 'contact',
    items,
    totalCount: items.length,
    hasMore,
  };
}

export async function searchCustomers(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { companies } = schema;
  const term = `%${q.toLowerCase()}%`;
  const score = sql<number>`GREATEST(
    ${scoreColumn(companies.name, q)},
    ${scoreColumn(companies.tradingName, q)},
    ${emailScore(companies.email, q)}
  )`;

  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      tradingName: companies.tradingName,
      email: companies.email,
      score,
      updatedAt: companies.updatedAt,
    })
    .from(companies)
    .where(
      and(
        isNull(companies.deletedAt),
        or(
          sql`lower(${companies.name}) LIKE ${term}`,
          sql`lower(${companies.tradingName}) LIKE ${term}`,
          sql`lower(${companies.email}) LIKE ${term}`,
        ),
      ),
    )
    .orderBy(desc(score), desc(companies.updatedAt), desc(companies.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => {
    const display = (r.name?.trim()) || (r.tradingName?.trim()) || r.email || 'Company';
    return {
      id: r.id,
      type: 'customer',
      title: display,
      subtitle: r.tradingName && r.tradingName !== r.name ? r.tradingName : r.email || null,
      url: buildResultUrl('customer', r.id),
      score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
    };
  });

  return {
    type: 'customer',
    items,
    totalCount: items.length,
    hasMore,
  };
}

export async function searchLeads(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { crmLeads } = schema;
  const term = `%${q.toLowerCase()}%`;
  const score = sql<number>`GREATEST(
    ${scoreColumn(crmLeads.fullName, q)},
    ${scoreColumn(crmLeads.firstName, q)},
    ${scoreColumn(crmLeads.lastName, q)},
    ${scoreColumn(crmLeads.companyName, q)},
    ${emailScore(crmLeads.email, q)}
  )`;

  const rows = await db
    .select({
      id: crmLeads.id,
      firstName: crmLeads.firstName,
      lastName: crmLeads.lastName,
      fullName: crmLeads.fullName,
      companyName: crmLeads.companyName,
      email: crmLeads.email,
      status: crmLeads.status,
      score,
      updatedAt: crmLeads.updatedAt,
    })
    .from(crmLeads)
    .where(
      and(
        isNull(crmLeads.deletedAt),
        or(
          sql`lower(${crmLeads.fullName}) LIKE ${term}`,
          sql`lower(${crmLeads.firstName}) LIKE ${term}`,
          sql`lower(${crmLeads.lastName}) LIKE ${term}`,
          sql`lower(${crmLeads.companyName}) LIKE ${term}`,
          sql`lower(${crmLeads.email}) LIKE ${term}`,
        ),
      ),
    )
    .orderBy(desc(score), desc(crmLeads.updatedAt), desc(crmLeads.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => {
    const display =
      (r.fullName?.trim()) ||
      [r.firstName, r.lastName].filter(Boolean).join(' ').trim() ||
      r.email ||
      'Lead';
    return {
      id: r.id,
      type: 'lead',
      title: display,
      subtitle: r.companyName || r.email || null,
      url: buildResultUrl('lead', r.id),
      score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
    };
  });

  return {
    type: 'lead',
    items,
    totalCount: items.length,
    hasMore,
  };
}

export async function searchOpportunities(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { crmOpportunities } = schema;
  const term = `%${q.toLowerCase()}%`;
  const score = sql<number>`GREATEST(
    ${scoreColumn(crmOpportunities.name, q)},
    ${scoreColumn(crmOpportunities.customerName, q)}
  )`;

  const rows = await db
    .select({
      id: crmOpportunities.id,
      name: crmOpportunities.name,
      customerName: crmOpportunities.customerName,
      stage: crmOpportunities.stage,
      score,
      updatedAt: crmOpportunities.updatedAt,
    })
    .from(crmOpportunities)
    .where(
      and(
        isNull(crmOpportunities.deletedAt),
        or(
          sql`lower(${crmOpportunities.name}) LIKE ${term}`,
          sql`lower(${crmOpportunities.customerName}) LIKE ${term}`,
        ),
      ),
    )
    .orderBy(desc(score), desc(crmOpportunities.updatedAt), desc(crmOpportunities.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    type: 'opportunity',
    title: r.name || 'Opportunity',
    subtitle: r.customerName || r.stage || null,
    url: buildResultUrl('opportunity', r.id),
    score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
  }));

  return {
    type: 'opportunity',
    items,
    totalCount: items.length,
    hasMore,
  };
}

export async function searchTickets(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { helpdeskTickets } = schema;
  const term = `%${q.toLowerCase()}%`;
  const score = sql<number>`GREATEST(
    ${scoreColumn(helpdeskTickets.subject, q)},
    ${scoreColumn(helpdeskTickets.ticketNumber, q)},
    ${scoreColumn(helpdeskTickets.customerName, q)},
    ${emailScore(helpdeskTickets.customerEmail, q)}
  )`;

  const rows = await db
    .select({
      id: helpdeskTickets.id,
      ticketNumber: helpdeskTickets.ticketNumber,
      subject: helpdeskTickets.subject,
      status: helpdeskTickets.status,
      customerName: helpdeskTickets.customerName,
      score,
      updatedAt: helpdeskTickets.updatedAt,
    })
    .from(helpdeskTickets)
    .where(
      and(
        isNull(helpdeskTickets.deletedAt),
        or(
          sql`lower(${helpdeskTickets.subject}) LIKE ${term}`,
          sql`lower(${helpdeskTickets.ticketNumber}) LIKE ${term}`,
          sql`lower(${helpdeskTickets.customerName}) LIKE ${term}`,
          sql`lower(${helpdeskTickets.customerEmail}) LIKE ${term}`,
        ),
      ),
    )
    .orderBy(desc(score), desc(helpdeskTickets.updatedAt), desc(helpdeskTickets.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    type: 'ticket',
    title: r.subject || `Ticket ${r.ticketNumber}`,
    subtitle: r.ticketNumber
      ? withSuffix(`#${r.ticketNumber}`, r.customerName)
      : r.customerName || r.status || null,
    url: buildResultUrl('ticket', r.id),
    score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
  }));

  return { type: 'ticket', items, totalCount: items.length, hasMore };
}

export async function searchArticles(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { helpdeskArticles } = schema;
  const term = `%${q.toLowerCase()}%`;
  const score = sql<number>`GREATEST(
    ${scoreColumn(helpdeskArticles.title, q)},
    ${scoreColumn(helpdeskArticles.slug, q)},
    ${scoreColumn(helpdeskArticles.categoryName, q)}
  )`;

  const rows = await db
    .select({
      id: helpdeskArticles.id,
      title: helpdeskArticles.title,
      slug: helpdeskArticles.slug,
      excerpt: helpdeskArticles.excerpt,
      categoryName: helpdeskArticles.categoryName,
      score,
      updatedAt: helpdeskArticles.updatedAt,
    })
    .from(helpdeskArticles)
    .where(
      and(
        isNull(helpdeskArticles.deletedAt),
        or(
          sql`lower(${helpdeskArticles.title}) LIKE ${term}`,
          sql`lower(${helpdeskArticles.slug}) LIKE ${term}`,
          sql`lower(${helpdeskArticles.categoryName}) LIKE ${term}`,
        ),
      ),
    )
    .orderBy(desc(score), desc(helpdeskArticles.updatedAt), desc(helpdeskArticles.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    type: 'article',
    title: r.title || 'Article',
    subtitle: r.categoryName || (r.excerpt ? r.excerpt.slice(0, 80) : null),
    url: buildResultUrl('article', r.id),
    score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
  }));

  return { type: 'article', items, totalCount: items.length, hasMore };
}

export async function searchKnowledgePages(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { knowledgePages, knowledgeSpaces } = schema;
  const term = `%${q.toLowerCase()}%`;
  const score = sql<number>`GREATEST(
    ${scoreColumn(knowledgePages.title, q)},
    ${scoreColumn(knowledgePages.contentText, q)}
  )`;

  // Only open teamspaces — this search does not check teamspace membership
  // (it could now: the searcher's id is passed in, see `searchSheets`), so
  // closed/private teamspaces and personal spaces stay out (WeldKnow's own
  // sidebar is the way into those).
  const rows = await db
    .select({
      id: knowledgePages.id,
      title: knowledgePages.title,
      contentText: knowledgePages.contentText,
      spaceName: knowledgeSpaces.name,
      score,
      updatedAt: knowledgePages.updatedAt,
    })
    .from(knowledgePages)
    .innerJoin(knowledgeSpaces, eq(knowledgePages.spaceId, knowledgeSpaces.id))
    .where(
      and(
        isNull(knowledgePages.deletedAt),
        isNull(knowledgeSpaces.deletedAt),
        eq(knowledgeSpaces.kind, 'team'),
        eq(knowledgeSpaces.visibility, 'open'),
        or(
          sql`lower(${knowledgePages.title}) LIKE ${term}`,
          sql`lower(${knowledgePages.contentText}) LIKE ${term}`,
        ),
      ),
    )
    .orderBy(desc(score), desc(knowledgePages.updatedAt), desc(knowledgePages.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    type: 'knowledge_page',
    title: r.title || 'Untitled',
    subtitle: r.spaceName || (r.contentText ? r.contentText.slice(0, 80) : null),
    url: buildResultUrl('knowledge_page', r.id),
    score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
  }));

  return { type: 'knowledge_page', items, totalCount: items.length, hasMore };
}

export async function searchProducts(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { products } = schema;
  const term = `%${q.toLowerCase()}%`;
  const score = sql<number>`GREATEST(
    ${scoreColumn(products.name, q)},
    ${scoreColumn(products.sku, q)},
    ${scoreColumn(products.barcode, q)}
  )`;

  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      shortDescription: products.shortDescription,
      score,
      updatedAt: products.updatedAt,
    })
    .from(products)
    .where(
      and(
        isNull(products.deletedAt),
        or(
          sql`lower(${products.name}) LIKE ${term}`,
          sql`lower(${products.sku}) LIKE ${term}`,
          sql`lower(${products.barcode}) LIKE ${term}`,
        ),
      ),
    )
    .orderBy(desc(score), desc(products.updatedAt), desc(products.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    type: 'product',
    title: r.name || 'Product',
    subtitle: r.sku ? `SKU: ${r.sku}` : (r.shortDescription ?? null),
    url: buildResultUrl('product', r.id),
    score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
  }));

  return { type: 'product', items, totalCount: items.length, hasMore };
}

export async function searchInvoices(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { invoices } = schema;
  const term = `%${q.toLowerCase()}%`;
  const score = sql<number>`GREATEST(
    ${scoreColumn(invoices.invoiceNumber, q)},
    ${scoreColumn(invoices.contactName, q)},
    ${emailScore(invoices.contactEmail, q)}
  )`;

  const rows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      contactName: invoices.contactName,
      status: invoices.status,
      score,
      updatedAt: invoices.updatedAt,
    })
    .from(invoices)
    .where(
      and(
        isNull(invoices.deletedAt),
        or(
          sql`lower(${invoices.invoiceNumber}) LIKE ${term}`,
          sql`lower(${invoices.contactName}) LIKE ${term}`,
          sql`lower(${invoices.contactEmail}) LIKE ${term}`,
        ),
      ),
    )
    .orderBy(desc(score), desc(invoices.updatedAt), desc(invoices.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    type: 'invoice',
    title: r.invoiceNumber ? `Invoice ${r.invoiceNumber}` : 'Invoice',
    subtitle: r.contactName || r.status || null,
    url: buildResultUrl('invoice', r.id),
    score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
  }));

  return { type: 'invoice', items, totalCount: items.length, hasMore };
}

export async function searchBills(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { bills } = schema;
  const term = `%${q.toLowerCase()}%`;
  const score = sql<number>`GREATEST(
    ${scoreColumn(bills.billNumber, q)},
    ${scoreColumn(bills.contactName, q)}
  )`;

  const rows = await db
    .select({
      id: bills.id,
      billNumber: bills.billNumber,
      contactName: bills.contactName,
      status: bills.status,
      score,
      updatedAt: bills.updatedAt,
    })
    .from(bills)
    .where(
      and(
        isNull(bills.deletedAt),
        or(
          sql`lower(${bills.billNumber}) LIKE ${term}`,
          sql`lower(${bills.contactName}) LIKE ${term}`,
        ),
      ),
    )
    .orderBy(desc(score), desc(bills.updatedAt), desc(bills.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    type: 'bill',
    title: r.billNumber ? `Bill ${r.billNumber}` : 'Bill',
    subtitle: r.contactName || r.status || null,
    url: buildResultUrl('bill', r.id),
    score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
  }));

  return { type: 'bill', items, totalCount: items.length, hasMore };
}

export async function searchProjects(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { projects } = schema;
  const term = `%${q.toLowerCase()}%`;
  const score = sql<number>`GREATEST(
    ${scoreColumn(projects.name, q)},
    ${scoreColumn(projects.code, q)}
  )`;

  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      code: projects.code,
      status: projects.status,
      description: projects.description,
      score,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .where(
      and(
        isNull(projects.deletedAt),
        or(
          sql`lower(${projects.name}) LIKE ${term}`,
          sql`lower(${projects.code}) LIKE ${term}`,
        ),
      ),
    )
    .orderBy(desc(score), desc(projects.updatedAt), desc(projects.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    type: 'project',
    title: r.name || 'Project',
    subtitle: r.code ? withSuffix(r.code, r.status) : (r.status || null),
    url: buildResultUrl('project', r.id),
    score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
  }));

  return { type: 'project', items, totalCount: items.length, hasMore };
}

export async function searchTasks(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { tasks } = schema;
  const term = `%${q.toLowerCase()}%`;
  const score = sql<number>`GREATEST(
    ${scoreColumn(tasks.title, q)},
    ${scoreColumn(tasks.key, q)}
  )`;

  // Let users jump to a task by its number: "TASK-1042", "#1042", or "1042".
  const numberRef = q.trim().replace(/^#/, '').replace(/^task-/i, '');
  const parsedNumber = /^\d+$/.test(numberRef) ? Number(numberRef) : null;

  const matchClauses = [
    sql`lower(${tasks.title}) LIKE ${term}`,
    sql`lower(${tasks.key}) LIKE ${term}`,
  ];
  if (parsedNumber !== null) {
    matchClauses.push(sql`${tasks.number} = ${parsedNumber}`);
  }

  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      key: tasks.key,
      number: tasks.number,
      status: tasks.status,
      score,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(and(isNull(tasks.deletedAt), or(...matchClauses)))
    .orderBy(desc(score), desc(tasks.updatedAt), desc(tasks.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => {
    // Prefer the human-friendly task number in the subtitle, falling back to the
    // external key, then the status.
    const ref = r.number != null ? String(r.number) : r.key || null;
    const subtitle = ref
      ? withSuffix(ref, r.status)
      : r.status || null;
    return {
      id: r.id,
      type: 'task',
      title: r.title || 'Task',
      subtitle,
      url: buildResultUrl('task', r.id),
      score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
    };
  });

  return { type: 'task', items, totalCount: items.length, hasMore };
}

/**
 * WeldMerge issues, matched on the title or the key (`PLAT-209`, or a part of
 * it). A hit opens the issue page, which reads an id as well as a key.
 */
export async function searchMergeIssues(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { mergeIssues, mergeTeams } = schema;
  const contains = `%${escapeLike(q.toLowerCase())}%`;
  const keyOf = sql`${mergeTeams.key} || '-' || ${mergeIssues.number}::text`;
  const score = sql<number>`GREATEST(${scoreColumn(mergeIssues.title, q)}, ${scoreColumn(keyOf, q)})`;

  const rows = await db
    .select({
      id: mergeIssues.id,
      title: mergeIssues.title,
      key: sql<string>`${keyOf}`,
      status: mergeIssues.status,
      score,
      updatedAt: mergeIssues.updatedAt,
    })
    .from(mergeIssues)
    .innerJoin(mergeTeams, eq(mergeTeams.id, mergeIssues.teamId))
    .where(
      and(
        isNull(mergeIssues.deletedAt),
        isNull(mergeTeams.deletedAt),
        or(sql`lower(${mergeIssues.title}) LIKE ${contains}`, sql`lower(${keyOf}) LIKE ${contains}`),
      ),
    )
    .orderBy(desc(score), desc(mergeIssues.updatedAt), desc(mergeIssues.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    type: 'merge_issue',
    title: r.title || r.key,
    subtitle: withSuffix(r.key, r.status),
    url: buildResultUrl('merge_issue', r.id),
    score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
  }));
  return { type: 'merge_issue', items, totalCount: items.length, hasMore };
}

/**
 * WeldMerge pull requests (of repositories still connected), matched on the
 * title, the branch, or the number (`#123` or `123`).
 */
export async function searchMergePullRequests(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { mergePullRequests, mergeRepositories } = schema;
  const contains = `%${escapeLike(q.toLowerCase())}%`;
  const numberRef = /^#?(\d{1,9})$/.exec(q.trim());
  const score = sql<number>`GREATEST(${scoreColumn(mergePullRequests.title, q)}, ${scoreColumn(mergePullRequests.headRef, q)})`;

  const rows = await db
    .select({
      id: mergePullRequests.id,
      title: mergePullRequests.title,
      number: mergePullRequests.number,
      state: mergePullRequests.state,
      repository: mergeRepositories.fullName,
      score,
      providerUpdatedAt: mergePullRequests.providerUpdatedAt,
    })
    .from(mergePullRequests)
    .innerJoin(mergeRepositories, eq(mergeRepositories.id, mergePullRequests.repositoryId))
    .where(
      and(
        isNull(mergeRepositories.deletedAt),
        or(
          sql`lower(${mergePullRequests.title}) LIKE ${contains}`,
          sql`lower(${mergePullRequests.headRef}) LIKE ${contains}`,
          numberRef ? eq(mergePullRequests.number, Number(numberRef[1])) : undefined,
        ),
      ),
    )
    .orderBy(desc(score), desc(mergePullRequests.providerUpdatedAt), desc(mergePullRequests.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    type: 'merge_pull_request',
    title: r.title || `#${r.number}`,
    subtitle: withSuffix(`${r.repository}#${r.number}`, r.state),
    url: buildResultUrl('merge_pull_request', r.id),
    score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
  }));
  return { type: 'merge_pull_request', items, totalCount: items.length, hasMore };
}

/** Escapes `\`, `%` and `_` so typed text matches itself in a LIKE pattern. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Spreadsheets, matched on the name of their WeldDrive file.
 *
 * Mirrors `listSheets` in sheets-api: the sheet's file is not in the trash and
 * belongs to no module record (a WeldFlow project's sheets follow the project's
 * members, not the drive, so they stay out). Who may open a spreadsheet is a
 * per-person WeldDrive question (owner, shares, general access, folders), so
 * the rows are narrowed to what `userId` can see, and nobody is no one: without
 * a user nothing is returned.
 */
export async function searchSheets(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
  userId: string | null,
): Promise<SearchResultGroup> {
  const none: SearchResultGroup = { type: 'sheet', items: [], totalCount: 0, hasMore: false };
  if (!userId) return none;

  const { sheets, files } = schema;
  const term = q.toLowerCase();
  const escaped = escapeLike(term);
  const contains = `%${escaped}%`;
  const startsWith = `${escaped}%`;
  const nameMatches = and(
    isNull(files.deletedAt),
    isNull(files.entityType),
    sql`lower(${files.fileName}) LIKE ${contains}`,
  );

  // Most keystrokes match no spreadsheet. Skip loading the drive's folder tree
  // and the caller's shares until one does.
  const [candidate] = await db
    .select({ id: sheets.id })
    .from(sheets)
    .innerJoin(files, eq(files.id, sheets.fileId))
    .where(nameMatches)
    .limit(1);
  if (!candidate) return none;

  const access = await loadDriveAccessForUser(db, userId);
  const score = sql<number>`CASE
    WHEN lower(${files.fileName}) = ${term} THEN 1.0
    WHEN lower(${files.fileName}) LIKE ${startsWith} THEN 0.9
    WHEN lower(${files.fileName}) LIKE ${contains} THEN 0.6
    ELSE 0
  END`;
  const changedAt = sql`greatest(${sheets.updatedAt}, ${files.updatedAt})`;

  const rows = await db
    .select({ id: sheets.id, name: files.fileName, score })
    .from(sheets)
    .innerJoin(files, eq(files.id, sheets.fileId))
    .where(and(nameMatches, visibleFilesCondition(access)))
    .orderBy(desc(score), desc(changedAt), desc(sheets.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    type: 'sheet',
    title: r.name || 'Spreadsheet',
    subtitle: null,
    url: buildResultUrl('sheet', r.id),
    score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
  }));

  return { type: 'sheet', items, totalCount: items.length, hasMore };
}

export async function searchDomains(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { hostDomains } = schema;
  const term = `%${q.toLowerCase()}%`;
  const score = sql<number>`GREATEST(
    ${scoreColumn(hostDomains.fullDomain, q)},
    ${scoreColumn(hostDomains.name, q)},
    ${scoreColumn(hostDomains.tld, q)}
  )`;

  const rows = await db
    .select({
      id: hostDomains.id,
      fullDomain: hostDomains.fullDomain,
      name: hostDomains.name,
      tld: hostDomains.tld,
      status: hostDomains.status,
      registrar: hostDomains.registrar,
      score,
      updatedAt: hostDomains.updatedAt,
    })
    .from(hostDomains)
    .where(
      and(
        isNull(hostDomains.deletedAt),
        sql`${hostDomains.registrationStatus} IS DISTINCT FROM 'pending_payment'`,
        sql`NOT (${hostDomains.status} = 'cancelled' AND ${hostDomains.registrationStatus} IS NOT DISTINCT FROM 'failed')`,
        or(
          sql`lower(${hostDomains.fullDomain}) LIKE ${term}`,
          sql`lower(${hostDomains.name}) LIKE ${term}`,
          sql`lower(${hostDomains.tld}) LIKE ${term}`,
        ),
      ),
    )
    .orderBy(desc(score), desc(hostDomains.updatedAt), desc(hostDomains.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    type: 'domain',
    title: r.fullDomain || `${r.name}.${r.tld}`,
    subtitle: r.registrar
      ? withSuffix(publicDomainRegistrar(r.registrar), r.status)
      : (r.status || null),
    url: buildResultUrl('domain', r.id),
    score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
  }));

  return { type: 'domain', items, totalCount: items.length, hasMore };
}

/**
 * WeldBoard boards, matched on the name of their WeldDrive file, the same way
 * as spreadsheets (`searchSheets`): not in the trash, of no module record (a
 * WeldFlow project's boards follow the project), narrowed to what `userId`
 * may see in WeldDrive; without a user nothing is returned.
 */
export async function searchBoards(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
  userId: string | null,
): Promise<SearchResultGroup> {
  const none: SearchResultGroup = { type: 'board', items: [], totalCount: 0, hasMore: false };
  if (!userId) return none;

  const { whiteboards, files } = schema;
  const term = q.toLowerCase();
  const escaped = escapeLike(term);
  const contains = `%${escaped}%`;
  const startsWith = `${escaped}%`;
  const nameMatches = and(isNull(files.deletedAt), isNull(files.entityType), sql`lower(${files.fileName}) LIKE ${contains}`);

  const [candidate] = await db.select({ id: whiteboards.id }).from(whiteboards).innerJoin(files, eq(files.id, whiteboards.fileId)).where(nameMatches).limit(1);
  if (!candidate) return none;

  const access = await loadDriveAccessForUser(db, userId);
  const score = sql<number>`CASE
    WHEN lower(${files.fileName}) = ${term} THEN 1.0
    WHEN lower(${files.fileName}) LIKE ${startsWith} THEN 0.9
    WHEN lower(${files.fileName}) LIKE ${contains} THEN 0.6
    ELSE 0
  END`;
  const changedAt = sql`greatest(${whiteboards.updatedAt}, ${files.updatedAt})`;
  const rows = await db
    .select({ id: whiteboards.id, name: files.fileName, score })
    .from(whiteboards)
    .innerJoin(files, eq(files.id, whiteboards.fileId))
    .where(and(nameMatches, visibleFilesCondition(access)))
    .orderBy(desc(score), desc(changedAt), desc(whiteboards.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    type: 'board',
    title: r.name || 'Board',
    subtitle: null,
    url: buildResultUrl('board', r.id),
    score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
  }));
  return { type: 'board', items, totalCount: items.length, hasMore };
}

// ============================================================================
// Records visible per person, and the rest of the modules' lists
// ============================================================================
//
// Every function below copies the module's own list rule, so a search never
// shows what that module's list would hide (the file and line are named on
// each). The term is matched escaped, so a typed `_` or `%` matches itself.

/** The lower-cased term and its LIKE patterns, escaped. */
interface LikeTerms {
  lower: string;
  startsWith: string;
  contains: string;
}

function likeTerms(q: string): LikeTerms {
  const lower = q.toLowerCase();
  const escaped = escapeLike(lower);
  return { lower, startsWith: `${escaped}%`, contains: `%${escaped}%` };
}

/** 1.0 exact, 0.9 prefix, 0.6 substring (an e-mail column: 1.0 / 0.7 / 0.3). */
function scoreText(col: unknown, t: LikeTerms, weights: [number, number, number] = [1, 0.9, 0.6]) {
  return sql<number>`CASE
    WHEN lower(${col}) = ${t.lower} THEN ${sql.raw(weights[0].toFixed(1))}
    WHEN lower(${col}) LIKE ${t.startsWith} THEN ${sql.raw(weights[1].toFixed(1))}
    WHEN lower(${col}) LIKE ${t.contains} THEN ${sql.raw(weights[2].toFixed(1))}
    ELSE 0
  END`;
}

const matchesText = (col: unknown, t: LikeTerms) => sql`lower(${col}) LIKE ${t.contains}`;

const emptyGroup = (type: SearchEntityType): SearchResultGroup => ({ type, items: [], totalCount: 0, hasMore: false });

const toScore = (score: unknown): number | null => (typeof score === 'number' ? score : Number(score) || null);

/** `limit + 1` rows become a group: `hasMore` is the extra row. */
function toGroup<R extends { id: string; score: unknown }>(
  type: SearchEntityType,
  rows: R[],
  limit: number,
  describe: (row: R) => { title: string; subtitle: string | null },
): SearchResultGroup {
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    type,
    ...describe(r),
    url: buildResultUrl(type, r.id),
    score: toScore(r.score),
  }));
  return { type, items, totalCount: items.length, hasMore: rows.length > limit };
}

const excerpt = (text: string | null | undefined): string | null => (text ? text.slice(0, 80) : null);

/** The caller's WeldDrive access, once per search however many Drive types ask. */
function driveAccessOf(db: Database, caller: SearchCaller): Promise<DriveAccessIndex> {
  return caller.driveAccess ? caller.driveAccess() : loadDriveAccessForUser(db, caller.userId);
}

/**
 * WeldDocs documents, matched on the name of their WeldDrive file, the same
 * way as spreadsheets (`searchSheets`). Mirrors `listDocs` in docs-api
 * (services/docs.ts: a checkpoint in R2, `snapshotKey`, marks a WeldDocs
 * document, and the file is not in the trash); a document of a module record
 * stays out, as for spreadsheets. Narrowed to what the caller may see in
 * WeldDrive; without a user nothing is returned.
 */
export async function searchDocuments(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
  caller: SearchCaller,
): Promise<SearchResultGroup> {
  if (!caller.userId) return emptyGroup('document');
  const { docs, files } = schema;
  const t = likeTerms(q);
  const nameMatches = and(
    isNotNull(docs.snapshotKey),
    isNull(files.deletedAt),
    isNull(files.entityType),
    matchesText(files.fileName, t),
  );

  // Most keystrokes match no document: skip the drive's folder tree until one does.
  const [candidate] = await db
    .select({ id: docs.id })
    .from(docs)
    .innerJoin(files, eq(files.id, docs.fileId))
    .where(nameMatches)
    .limit(1);
  if (!candidate) return emptyGroup('document');

  const access = await driveAccessOf(db, caller);
  const score = scoreText(files.fileName, t);
  const changedAt = sql`greatest(${docs.updatedAt}, ${files.updatedAt})`;
  const rows = await db
    .select({ id: docs.id, name: files.fileName, score })
    .from(docs)
    .innerJoin(files, eq(files.id, docs.fileId))
    .where(and(nameMatches, visibleFilesCondition(access)))
    .orderBy(desc(score), desc(changedAt), desc(docs.id))
    .limit(limit + 1);
  return toGroup('document', rows, limit, (r) => ({ title: r.name || 'Document', subtitle: null }));
}

/**
 * WeldDrive files, matched on their name. Mirrors `/api/files` in app-api
 * (routes/files/index.ts): files not in the trash, narrowed to what the caller
 * may see. A file of a module record (`entityType`) is not a Drive upload, and
 * the files behind documents, spreadsheets and boards are found as those types.
 * Without a user nothing is returned.
 */
export async function searchFiles(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
  caller: SearchCaller,
): Promise<SearchResultGroup> {
  if (!caller.userId) return emptyGroup('drive_file');
  const { files, docs, sheets, whiteboards } = schema;
  const t = likeTerms(q);
  const nameMatches = and(
    isNull(files.deletedAt),
    isNull(files.entityType),
    matchesText(files.fileName, t),
    sql`NOT EXISTS (SELECT 1 FROM ${docs} WHERE ${docs.fileId} = ${files.id})`,
    sql`NOT EXISTS (SELECT 1 FROM ${sheets} WHERE ${sheets.fileId} = ${files.id})`,
    sql`NOT EXISTS (SELECT 1 FROM ${whiteboards} WHERE ${whiteboards.fileId} = ${files.id})`,
  );

  const [candidate] = await db.select({ id: files.id }).from(files).where(nameMatches).limit(1);
  if (!candidate) return emptyGroup('drive_file');

  const access = await driveAccessOf(db, caller);
  const score = scoreText(files.fileName, t);
  const rows = await db
    .select({ id: files.id, name: files.fileName, score })
    .from(files)
    .where(and(nameMatches, visibleFilesCondition(access)))
    .orderBy(desc(score), desc(files.updatedAt), desc(files.id))
    .limit(limit + 1);
  return toGroup('drive_file', rows, limit, (r) => ({ title: r.name || 'File', subtitle: null }));
}

/**
 * WeldForms forms by title. Mirrors `listForms` in forms-api
 * (services/forms.ts `visibleTo`): `forms:manage` sees every form; anyone else
 * the forms open to the workspace, their own, and those they are on the access
 * list of.
 */
export async function searchForms(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
  caller: SearchCaller,
): Promise<SearchResultGroup> {
  const { userId } = caller;
  if (!userId) return emptyGroup('form');
  const { forms, formAccess } = schema;
  const t = likeTerms(q);
  const score = scoreText(forms.title, t);
  const visible = caller.can('forms:manage')
    ? undefined
    : or(
        eq(forms.access, 'workspace'),
        eq(forms.ownerUserId, userId),
        sql`${forms.id} IN (SELECT ${formAccess.formId} FROM ${formAccess} WHERE ${formAccess.userId} = ${userId})`,
      );
  const rows = await db
    .select({ id: forms.id, title: forms.title, status: forms.status, score })
    .from(forms)
    .where(and(matchesText(forms.title, t), visible))
    .orderBy(desc(score), desc(forms.updatedAt), desc(forms.id))
    .limit(limit + 1);
  return toGroup('form', rows, limit, (r) => ({ title: r.title || 'Form', subtitle: r.status || null }));
}

/**
 * WeldDesk conversations by title, customer name, e-mail or number (`#42`).
 * Mirrors `listDeskConversations` (packages/core/db/src/lib/desk.ts), which
 * the desk inbox lists through desk-api: every conversation, for anyone who
 * may read conversations.
 */
export async function searchConversations(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { deskConversations: c } = schema;
  const t = likeTerms(q);
  const reference = /^#?(\d{1,9})$/.exec(q.trim());
  const number = reference ? Number(reference[1]) : null;
  const score = sql<number>`GREATEST(
    ${scoreText(c.title, t)},
    ${scoreText(c.name, t)},
    ${scoreText(c.email, t, [1, 0.7, 0.3])},
    ${number === null ? sql`0` : sql`CASE WHEN ${c.conversationNumber} = ${number} THEN 1.0 ELSE 0 END`}
  )`;
  const rows = await db
    .select({
      id: c.id,
      title: c.title,
      name: c.name,
      email: c.email,
      conversationNumber: c.conversationNumber,
      score,
    })
    .from(c)
    .where(
      or(
        matchesText(c.title, t),
        matchesText(c.name, t),
        matchesText(c.email, t),
        number === null ? undefined : eq(c.conversationNumber, number),
      ),
    )
    .orderBy(desc(score), desc(c.updatedAt), desc(c.id))
    .limit(limit + 1);
  return toGroup('conversation', rows, limit, (r) => ({
    title: r.title || r.name || r.email || `Conversation #${r.conversationNumber}`,
    subtitle: withSuffix(`#${r.conversationNumber}`, r.name || r.email),
  }));
}

/**
 * WeldMeet meetings by title. Mirrors `GET /api/meetings` in meet-api
 * (routes/meetings/index.ts `scopeFor`): the organiser's own meetings, unless
 * the caller holds `meetings:scope:all`.
 */
export async function searchMeetings(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
  caller: SearchCaller,
): Promise<SearchResultGroup> {
  const { userId } = caller;
  const all = caller.can('weldmeet:meetings:scope:all');
  if (!userId && !all) return emptyGroup('meeting');
  const { meetings } = schema;
  const t = likeTerms(q);
  const score = scoreText(meetings.title, t);
  const rows = await db
    .select({ id: meetings.id, title: meetings.title, status: meetings.status, score })
    .from(meetings)
    .where(
      and(
        isNull(meetings.deletedAt),
        matchesText(meetings.title, t),
        all || !userId ? undefined : eq(meetings.organizerId, userId),
      ),
    )
    .orderBy(desc(score), desc(meetings.updatedAt), desc(meetings.id))
    .limit(limit + 1);
  return toGroup('meeting', rows, limit, (r) => ({ title: r.title || 'Meeting', subtitle: r.status || null }));
}

/**
 * WeldSign signature requests by title. Mirrors `listEnvelopes` in
 * `@weldsuite/sign-domain` (envelopes.ts `visibleTo`): `sign_envelopes:manage`
 * sees every request; anyone else their own, and sent requests with a
 * recipient at their e-mail address (the one their member row holds).
 */
export async function searchSignEnvelopes(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
  caller: SearchCaller,
): Promise<SearchResultGroup> {
  const { userId } = caller;
  const manageAll = caller.can('sign_envelopes:manage');
  if (!userId && !manageAll) return emptyGroup('sign_envelope');
  const { signEnvelopes, signRecipients, workspaceMembers } = schema;

  let visible: SQL | undefined;
  if (!manageAll && userId) {
    const [member] = await db
      .select({ email: workspaceMembers.email })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
      .limit(1);
    const email = member?.email?.toLowerCase() ?? null;
    const own = eq(signEnvelopes.senderUserId, userId);
    visible = email
      ? or(
          own,
          and(
            ne(signEnvelopes.status, 'draft'),
            sql`${signEnvelopes.id} IN (SELECT ${signRecipients.envelopeId} FROM ${signRecipients} WHERE ${signRecipients.email} = ${email})`,
          ),
        )
      : own;
  }

  const t = likeTerms(q);
  const score = scoreText(signEnvelopes.title, t);
  const rows = await db
    .select({ id: signEnvelopes.id, title: signEnvelopes.title, status: signEnvelopes.status, score })
    .from(signEnvelopes)
    .where(
      and(
        eq(signEnvelopes.kind, 'envelope'),
        isNull(signEnvelopes.deletedAt),
        matchesText(signEnvelopes.title, t),
        visible,
      ),
    )
    .orderBy(desc(score), desc(signEnvelopes.updatedAt), desc(signEnvelopes.id))
    .limit(limit + 1);
  return toGroup('sign_envelope', rows, limit, (r) => ({
    title: r.title || 'Signature request',
    subtitle: r.status || null,
  }));
}

/**
 * WeldStash warehouses by name or code. Mirrors `GET /api/warehouses` in
 * stash-api (routes/warehouses/index.ts): not deleted, the same for everyone
 * who may read warehouses.
 */
export async function searchWarehouses(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { warehouses } = schema;
  const t = likeTerms(q);
  const score = sql<number>`GREATEST(${scoreText(warehouses.name, t)}, ${scoreText(warehouses.code, t)})`;
  const rows = await db
    .select({ id: warehouses.id, name: warehouses.name, code: warehouses.code, city: warehouses.city, score })
    .from(warehouses)
    .where(and(isNull(warehouses.deletedAt), or(matchesText(warehouses.name, t), matchesText(warehouses.code, t))))
    .orderBy(desc(score), desc(warehouses.updatedAt), desc(warehouses.id))
    .limit(limit + 1);
  return toGroup('warehouse', rows, limit, (r) => ({
    title: r.name || 'Warehouse',
    subtitle: r.code || r.city || null,
  }));
}

/**
 * WeldConnect workflows by name. Mirrors `listWorkflows` in connect-api
 * (services/workflows.ts): not deleted, and not a CRM sequence (a workflow
 * tagged `__type:sequence`, which WeldConnect's list leaves out).
 */
export async function searchWorkflows(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { workflows } = schema;
  const t = likeTerms(q);
  const score = scoreText(workflows.name, t);
  const rows = await db
    .select({ id: workflows.id, name: workflows.name, status: workflows.status, score })
    .from(workflows)
    .where(
      and(
        isNull(workflows.deletedAt),
        matchesText(workflows.name, t),
        sql`not (coalesce(${workflows.tags}, '[]'::jsonb) ? '__type:sequence')`,
      ),
    )
    .orderBy(desc(score), desc(workflows.updatedAt), desc(workflows.id))
    .limit(limit + 1);
  return toGroup('workflow', rows, limit, (r) => ({ title: r.name || 'Workflow', subtitle: r.status || null }));
}

/**
 * WeldAgent workspace agents by name. Mirrors `listAgents` in
 * `@weldsuite/agent-domain` (agents.ts): not deleted, and the agents the
 * caller may see (`agentVisibleTo`: the owner's, workspace-wide ones, the
 * ones they are a listed member of, everything for `weldagent:manage`).
 */
export async function searchAgents(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
  caller: SearchCaller,
): Promise<SearchResultGroup> {
  const { userId } = caller;
  const canManageAll = caller.can('weldagent:manage');
  if (!userId && !canManageAll) return emptyGroup('agent');
  const { weldagentAgents: a } = schema;
  const t = likeTerms(q);
  const score = scoreText(a.name, t);
  const rows = await db
    .select({ id: a.id, name: a.name, description: a.description, score })
    .from(a)
    .where(
      and(
        isNull(a.deletedAt),
        matchesText(a.name, t),
        agentVisibleTo({ userId: userId ?? '', canManageAll }),
      ),
    )
    .orderBy(desc(score), desc(a.updatedAt), desc(a.id))
    .limit(limit + 1);
  return toGroup('agent', rows, limit, (r) => ({ title: r.name || 'Agent', subtitle: excerpt(r.description) }));
}

/**
 * WeldReach campaigns by name. Mirrors `listCampaigns` in
 * `@weldsuite/reach-domain` (campaigns.ts): not deleted. (reach-api also
 * refuses a workspace whose WeldReach access staff have not approved; that
 * lives in the master database and is not read here.)
 */
export async function searchReachCampaigns(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { reachCampaigns } = schema;
  const t = likeTerms(q);
  const score = scoreText(reachCampaigns.name, t);
  const rows = await db
    .select({ id: reachCampaigns.id, name: reachCampaigns.name, status: reachCampaigns.status, score })
    .from(reachCampaigns)
    .where(and(isNull(reachCampaigns.deletedAt), matchesText(reachCampaigns.name, t)))
    .orderBy(desc(score), desc(reachCampaigns.updatedAt), desc(reachCampaigns.id))
    .limit(limit + 1);
  return toGroup('reach_campaign', rows, limit, (r) => ({
    title: r.name || 'Campaign',
    subtitle: r.status || null,
  }));
}

/**
 * WeldChat channels by name. Mirrors `GET /api/channels` in chat-api
 * (routes/channels/index.ts): public channels, and the ones the caller has
 * joined. Direct messages and record (entity) channels are not channels here:
 * their names are the people's and the record's.
 */
export async function searchChatChannels(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
  caller: SearchCaller,
): Promise<SearchResultGroup> {
  const { userId } = caller;
  if (!userId) return emptyGroup('chat_channel');
  const { chatChannels, chatChannelMembers } = schema;
  const t = likeTerms(q);
  const score = scoreText(chatChannels.name, t);
  const rows = await db
    .select({
      id: chatChannels.id,
      name: chatChannels.name,
      topic: chatChannels.topic,
      description: chatChannels.description,
      score,
    })
    .from(chatChannels)
    .where(
      and(
        isNull(chatChannels.deletedAt),
        matchesText(chatChannels.name, t),
        or(
          eq(chatChannels.type, 'public'),
          and(
            eq(chatChannels.type, 'private'),
            sql`EXISTS (SELECT 1 FROM ${chatChannelMembers} WHERE ${chatChannelMembers.channelId} = ${chatChannels.id} AND ${chatChannelMembers.userId} = ${userId})`,
          ),
        ),
      ),
    )
    .orderBy(desc(score), desc(chatChannels.updatedAt), desc(chatChannels.id))
    .limit(limit + 1);
  return toGroup('chat_channel', rows, limit, (r) => ({
    title: r.name || 'Channel',
    subtitle: excerpt(r.topic || r.description),
  }));
}

/**
 * WeldData lists by name. Mirrors `listLists` in data-api
 * (services/welddata.ts): not deleted, the same for everyone who may read
 * prospects.
 */
export async function searchDataLists(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { welddataLists } = schema;
  const t = likeTerms(q);
  const score = scoreText(welddataLists.name, t);
  const rows = await db
    .select({ id: welddataLists.id, name: welddataLists.name, description: welddataLists.description, score })
    .from(welddataLists)
    .where(and(isNull(welddataLists.deletedAt), matchesText(welddataLists.name, t)))
    .orderBy(desc(score), desc(welddataLists.updatedAt), desc(welddataLists.id))
    .limit(limit + 1);
  return toGroup('data_list', rows, limit, (r) => ({ title: r.name || 'List', subtitle: excerpt(r.description) }));
}

/**
 * WeldPanel tracked projects by name. Mirrors `listProjects` in panel-api
 * (services/projects.ts): not deleted, the same for everyone who may read
 * them.
 */
export async function searchPanelProjects(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { panelProjects } = schema;
  const t = likeTerms(q);
  const score = scoreText(panelProjects.name, t);
  const rows = await db
    .select({
      id: panelProjects.id,
      name: panelProjects.name,
      kind: panelProjects.kind,
      status: panelProjects.status,
      score,
    })
    .from(panelProjects)
    .where(and(isNull(panelProjects.deletedAt), matchesText(panelProjects.name, t)))
    .orderBy(desc(score), desc(panelProjects.updatedAt), desc(panelProjects.id))
    .limit(limit + 1);
  return toGroup('panel_project', rows, limit, (r) => ({
    title: r.name || 'Project',
    subtitle: withSuffix(r.kind, r.status),
  }));
}

// ============================================================================
// Registry + Orchestrator
// ============================================================================

// In `CANONICAL_ORDER`, which is also the order of `permittedTypes`. A key names
// the app where the object is shared between several (`files`, `workflows`,
// `channels`, `meetings`), as the module's own routes are checked in that app.
const ENTITY_REGISTRY: EntityRegistration[] = [
  { type: 'contact', permission: 'contacts:read', search: searchContacts },
  { type: 'customer', permission: 'contacts:read', search: searchCustomers },
  { type: 'lead', permission: 'leads:read', search: searchLeads },
  { type: 'opportunity', permission: 'opportunities:read', search: searchOpportunities },
  { type: 'ticket', permission: 'tickets:read', search: searchTickets },
  { type: 'conversation', permission: 'conversations:read', search: searchConversations },
  { type: 'article', permission: 'articles:read', search: searchArticles },
  { type: 'knowledge_page', permission: 'knowledge:read', search: searchKnowledgePages },
  { type: 'product', permission: 'products:read', search: searchProducts },
  { type: 'warehouse', permission: 'warehouses:read', search: searchWarehouses },
  { type: 'invoice', permission: 'invoices:read', search: searchInvoices },
  { type: 'bill', permission: 'bills:read', search: searchBills },
  { type: 'project', permission: 'projects:read', search: searchProjects },
  { type: 'task', permission: 'tasks:read', search: searchTasks },
  { type: 'merge_issue', permission: 'merge_issues:read', search: searchMergeIssues },
  { type: 'merge_pull_request', permission: 'merge_pull_requests:read', search: searchMergePullRequests },
  { type: 'document', permission: 'docs:read', search: searchDocuments },
  { type: 'sheet', permission: 'sheets:read', search: (db, ws, q, limit, caller) => searchSheets(db, ws, q, limit, caller.userId) },
  { type: 'board', permission: 'boards:read', search: (db, ws, q, limit, caller) => searchBoards(db, ws, q, limit, caller.userId) },
  { type: 'form', permission: 'forms:read', search: searchForms },
  { type: 'sign_envelope', permission: 'sign_envelopes:read', search: searchSignEnvelopes },
  { type: 'drive_file', permission: 'welddrive:files:read', search: searchFiles },
  { type: 'meeting', permission: 'weldmeet:meetings:read', search: searchMeetings },
  { type: 'chat_channel', permission: 'weldchat:channels:read', search: searchChatChannels },
  { type: 'reach_campaign', permission: 'reach_campaigns:read', search: searchReachCampaigns },
  { type: 'data_list', permission: 'prospects:read', search: searchDataLists },
  { type: 'panel_project', permission: 'panel_projects:read', search: searchPanelProjects },
  { type: 'workflow', permission: 'weldconnect:workflows:read', search: searchWorkflows },
  { type: 'agent', permission: 'weldagent:read', search: searchAgents },
  { type: 'domain', permission: 'domains:read', search: searchDomains },
];

export function getPermittedTypes(perms: PermissionLike): SearchEntityType[] {
  return ENTITY_REGISTRY.filter((r) => perms.hasAny([r.permission])).map((r) => r.type);
}

export async function runSearch(
  db: Database,
  workspaceId: string,
  params: RunSearchParams,
): Promise<{ groups: SearchResultGroup[]; permittedTypes: SearchEntityType[] }> {
  const permitted = ENTITY_REGISTRY.filter((r) => params.perms.hasAny([r.permission]));
  const filtered = params.types && params.types.length > 0
    ? permitted.filter((r) => params.types!.includes(r.type))
    : permitted;

  const term = params.lexicalTerm?.trim() || params.q;

  const userId = params.userId ?? null;
  let driveAccess: Promise<DriveAccessIndex> | undefined;
  const caller: SearchCaller = {
    userId,
    can: (permission) => params.perms.hasAny([permission]),
    driveAccess: () => (driveAccess ??= loadDriveAccessForUser(db, userId)),
  };
  const groups = await Promise.all(
    filtered.map((r) => r.search(db, workspaceId, term, params.limit, caller)),
  );

  // Sort by canonical order
  groups.sort(
    (a, b) => CANONICAL_ORDER.indexOf(a.type) - CANONICAL_ORDER.indexOf(b.type),
  );

  return {
    groups,
    permittedTypes: permitted.map((r) => r.type),
  };
}

