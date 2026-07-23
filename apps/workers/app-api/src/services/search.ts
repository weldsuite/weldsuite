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
import type { Database } from '../db';
import { schema } from '../db';
import {
  type SearchEntityType,
  type SearchResultGroup,
  type SearchResultItem,
} from '@weldsuite/app-api-client/schemas/search';

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
}

interface EntityRegistration {
  type: SearchEntityType;
  permission: string;
  search: (db: Database, workspaceId: string, q: string, limit: number) => Promise<SearchResultGroup>;
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
 */
function buildResultUrl(type: SearchEntityType, id: string): string {
  switch (type) {
    case 'contact':
      return `/weldcrm/contacts/${id}`;
    case 'customer':
      return `/weldcrm/customers/${id}`;
    case 'lead':
      return `/weldcrm/leads/${id}`;
    case 'opportunity':
      return `/weldcrm/opportunities/${id}`;
    case 'ticket':
      return `/welddesk/tickets/${id}`;
    case 'article':
      return `/welddesk/articles/${id}`;
    case 'knowledge_page':
      return `/weldknow/page/${id}`;
    case 'product':
      return `/weldstash/products/${id}`;
    case 'order':
      return `/weldstash/orders/${id}`;
    case 'invoice':
      return `/weldbooks/invoices/${id}`;
    case 'bill':
      return `/weldbooks/bills/${id}`;
    case 'project':
      return `/weldflow/projects/${id}`;
    case 'task':
      return `/weldflow/tasks/${id}`;
    case 'domain':
      return `/weldhost/domains/${id}`;
  }
}

// ============================================================================
// Score Helpers (rule-based; switch to similarity() when pg_trgm lands)
// ============================================================================

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
      (r.fullName && r.fullName.trim()) ||
      [r.firstName, r.lastName].filter(Boolean).join(' ').trim() ||
      r.email ||
      'Contact';
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
    const display = (r.name && r.name.trim()) || (r.tradingName && r.tradingName.trim()) || r.email || 'Customer';
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
      (r.fullName && r.fullName.trim()) ||
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
      ? `#${r.ticketNumber}${r.customerName ? ' · ' + r.customerName : ''}`
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

  // Private spaces are excluded — the search context has no user identity,
  // so only workspace-visible spaces are searchable here.
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
        sql`${knowledgeSpaces.visibility} != 'private'`,
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
    subtitle: r.code ? `${r.code}${r.status ? ' · ' + r.status : ''}` : (r.status || null),
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
    // Prefer the human-friendly TASK-<n> ref in the subtitle, falling back to the
    // external key, then the status.
    const ref = r.number != null ? `TASK-${r.number}` : r.key || null;
    const subtitle = ref
      ? `${ref}${r.status ? ' · ' + r.status : ''}`
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
      ? `${r.registrar}${r.status ? ' · ' + r.status : ''}`
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

  const groups = await Promise.all(
    filtered.map((r) => r.search(db, workspaceId, params.q, params.limit)),
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
