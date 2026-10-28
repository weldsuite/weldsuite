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

import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { loadDriveAccessForUser, visibleFilesCondition } from '@weldsuite/core-domain/drive-access';
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
   * The apps the caller can open, for picking where a product links (see
   * `buildResultUrl`). Only called when products match, so other searches
   * skip the lookup.
   */
  memberApps?: () => Promise<ReadonlySet<string>>;
  /**
   * Who is searching. Records that are visible per person rather than per
   * workspace (spreadsheets follow WeldDrive sharing) are filtered by it; with
   * no user (null or omitted) those types return nothing.
   */
  userId?: string | null;
}

interface EntityRegistration {
  type: SearchEntityType;
  permission: string;
  search: (
    db: Database,
    workspaceId: string,
    q: string,
    limit: number,
    /** The person searching, or null (see `RunSearchParams.userId`). */
    userId: string | null,
  ) => Promise<SearchResultGroup>;
}

// Canonical group ordering for the response.
const CANONICAL_ORDER: SearchEntityType[] = [
  'contact',
  'customer',
  'lead',
  'opportunity',
  'ticket',
  'article',
  'knowledge_page',
  'product',
  'order',
  'invoice',
  'bill',
  'project',
  'task',
  'sheet',
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
 * Products and orders open as object panels on their list page. WeldCommerce
 * and WeldStash list the same products, which link to WeldCommerce unless
 * `memberApps` shows the member can only open WeldStash (WeldCommerce would
 * show them its "not installed" screen). Only WeldCommerce has an orders list.
 *
 * Spreadsheets have a page of their own: `/weldsheets/:id`.
 */
export function buildResultUrl(
  type: SearchEntityType,
  id: string,
  memberApps?: ReadonlySet<string>,
): string {
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
    case 'article':
      return `/welddesk/help-center/articles/${id}`;
    case 'knowledge_page':
      return `/weldknow/page/${id}`;
    case 'product': {
      const app =
        memberApps && !memberApps.has('weldcommerce') && memberApps.has('weldstash')
          ? 'weldstash'
          : 'weldcommerce';
      return `/${app}/products?stack=product:${encodeURIComponent(id)}`;
    }
    case 'order':
      return `/weldcommerce/orders?stack=order:${encodeURIComponent(id)}`;
    case 'invoice':
      return `/weldbooks/invoices/${id}`;
    case 'bill':
      return `/weldbooks/bills/${id}`;
    case 'project':
      return `/weldflow/project/${id}`;
    case 'task':
      return `/weldflow/task/${id}`;
    case 'sheet':
      return `/weldsheets/${id}`;
    case 'domain':
      return `/weldhost/domains/${id}`;
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

export async function searchOrders(
  db: Database,
  _workspaceId: string,
  q: string,
  limit: number,
): Promise<SearchResultGroup> {
  const { orders } = schema;
  const term = `%${q.toLowerCase()}%`;
  const score = sql<number>`GREATEST(
    ${scoreColumn(orders.orderNumber, q)},
    ${scoreColumn(orders.customerName, q)},
    ${emailScore(orders.customerEmail, q)}
  )`;

  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      customerName: orders.customerName,
      status: orders.status,
      total: orders.total,
      currency: orders.currency,
      score,
      updatedAt: orders.updatedAt,
    })
    .from(orders)
    .where(
      and(
        isNull(orders.deletedAt),
        or(
          sql`lower(${orders.orderNumber}) LIKE ${term}`,
          sql`lower(${orders.customerName}) LIKE ${term}`,
          sql`lower(${orders.customerEmail}) LIKE ${term}`,
        ),
      ),
    )
    .orderBy(desc(score), desc(orders.updatedAt), desc(orders.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items: SearchResultItem[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    type: 'order',
    title: r.orderNumber ? `Order ${r.orderNumber}` : 'Order',
    subtitle: r.customerName || r.status || null,
    url: buildResultUrl('order', r.id),
    score: typeof r.score === 'number' ? r.score : Number(r.score) || null,
  }));

  return { type: 'order', items, totalCount: items.length, hasMore };
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

// ============================================================================
// Registry + Orchestrator
// ============================================================================

const ENTITY_REGISTRY: EntityRegistration[] = [
  { type: 'contact', permission: 'contacts:read', search: searchContacts },
  { type: 'customer', permission: 'contacts:read', search: searchCustomers },
  { type: 'lead', permission: 'leads:read', search: searchLeads },
  { type: 'opportunity', permission: 'opportunities:read', search: searchOpportunities },
  { type: 'ticket', permission: 'tickets:read', search: searchTickets },
  { type: 'article', permission: 'articles:read', search: searchArticles },
  { type: 'knowledge_page', permission: 'knowledge:read', search: searchKnowledgePages },
  { type: 'product', permission: 'products:read', search: searchProducts },
  { type: 'order', permission: 'orders:read', search: searchOrders },
  { type: 'invoice', permission: 'invoices:read', search: searchInvoices },
  { type: 'bill', permission: 'bills:read', search: searchBills },
  { type: 'project', permission: 'projects:read', search: searchProjects },
  { type: 'task', permission: 'tasks:read', search: searchTasks },
  { type: 'sheet', permission: 'sheets:read', search: searchSheets },
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

  const groups = await Promise.all(
    filtered.map((r) => r.search(db, workspaceId, term, params.limit, params.userId ?? null)),
  );

  // Sort by canonical order
  groups.sort(
    (a, b) => CANONICAL_ORDER.indexOf(a.type) - CANONICAL_ORDER.indexOf(b.type),
  );

  return {
    groups: await linkProductsToMemberApps(groups, params.memberApps),
    permittedTypes: permitted.map((r) => r.type),
  };
}

/**
 * Product hits are built with the WeldCommerce URL; once the member's apps are
 * known, relink them. A failed lookup keeps the WeldCommerce links.
 */
async function linkProductsToMemberApps(
  groups: SearchResultGroup[],
  memberApps: RunSearchParams['memberApps'],
): Promise<SearchResultGroup[]> {
  if (!memberApps || !groups.some((g) => g.type === 'product' && g.items.length > 0)) {
    return groups;
  }
  let apps: ReadonlySet<string>;
  try {
    apps = await memberApps();
  } catch (err) {
    console.error('[app-api/search] Failed to resolve member apps:', err);
    return groups;
  }
  return groups.map((g) =>
    g.type === 'product'
      ? { ...g, items: g.items.map((item) => ({ ...item, url: buildResultUrl('product', item.id, apps) })) }
      : g,
  );
}
