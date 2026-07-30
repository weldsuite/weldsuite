/**
 * Indexable-document registry — turns a tenant row into the text the semantic
 * search index embeds.
 *
 * One loader per entity type, each exposing two shapes of the same query:
 *  - `load()` for a single record, driven by an entity event
 *  - `page()`  for cursor-paged backfill of everything already in the tenant
 *
 * Keeping both on one object is deliberate: the incremental and backfill paths
 * must produce byte-identical documents, or a re-index would churn every row's
 * `content_hash` and re-embed a corpus that hasn't changed.
 *
 * Coverage is intentionally narrower than the lexical registry in
 * `services/search.ts`. Entities whose searchable content is a number or a
 * status — invoices, orders, bills, products, domains — gain nothing from a
 * semantic match and would dominate embedding spend, so they stay lexical-only.
 * Adding one later is a single entry here plus a backfill run.
 */

import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db';
import { schema } from '../../db';
import type { SearchEntityType } from '@weldsuite/app-api-client/schemas/search';
import { buildResultUrl } from '../search';

export interface IndexableDocument {
  entityType: SearchEntityType;
  entityId: string;
  title: string;
  subtitle: string | null;
  url: string;
  /** The text that gets embedded. Includes the title so a title-only query matches. */
  content: string;
}

/**
 * One page of a backfill walk.
 *
 * `rowsRead` and `lastScannedId` describe the rows the query actually returned,
 * which is NOT the same as `documents`: a row whose mapper yields `null` (a
 * nameless contact, an empty page) is dropped from `documents` but was still
 * scanned. The cursor has to advance on the scanned set, or the walk would
 * treat a partly-filtered page as the end of the entity type and abandon
 * everything after it.
 */
export interface DocumentPage {
  documents: IndexableDocument[];
  rowsRead: number;
  lastScannedId: string | null;
}

export interface DocumentLoader {
  type: SearchEntityType;
  /** One record by id. `null` when it is missing or soft-deleted. */
  load(db: Database, entityId: string): Promise<IndexableDocument | null>;
  /** A page of records ordered by id, for backfill. */
  page(db: Database, afterId: string | null, limit: number): Promise<DocumentPage>;
}

/** Join the parts of a document, dropping empties and normalising whitespace. */
function compose(parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Build a loader from a row-shaped mapper. Every entity follows the same
 * pattern — filter soft-deletes, map to a document — so only the table, the
 * selected columns and the mapping differ.
 */
function defineLoader<T extends { id: string }>(config: {
  type: SearchEntityType;
  /** Select the row set, already excluding soft-deleted records. */
  select: (db: Database) => {
    byId: (id: string) => Promise<T[]>;
    after: (afterId: string | null, limit: number) => Promise<T[]>;
  };
  toDocument: (row: T) => Omit<IndexableDocument, 'entityType' | 'entityId' | 'url'> | null;
}): DocumentLoader {
  const build = (row: T): IndexableDocument | null => {
    const mapped = config.toDocument(row);
    if (!mapped || !mapped.content) return null;
    return {
      entityType: config.type,
      entityId: row.id,
      url: buildResultUrl(config.type, row.id),
      ...mapped,
    };
  };

  return {
    type: config.type,
    async load(db, entityId) {
      const [row] = await config.select(db).byId(entityId);
      return row ? build(row) : null;
    },
    async page(db, afterId, limit) {
      const rows = await config.select(db).after(afterId, limit);
      return {
        documents: rows.map(build).filter((d): d is IndexableDocument => d !== null),
        rowsRead: rows.length,
        lastScannedId: rows.length > 0 ? rows[rows.length - 1]!.id : null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

const knowledgePageLoader = defineLoader({
  type: 'knowledge_page',
  select: (db) => {
    const { knowledgePages, knowledgeSpaces } = schema;
    // Private spaces are excluded for the same reason the lexical leg excludes
    // them: the index has no user identity to check membership against, so
    // anything indexed here is visible to every member of the workspace.
    const base = () =>
      db
        .select({
          id: knowledgePages.id,
          title: knowledgePages.title,
          contentText: knowledgePages.contentText,
          spaceName: knowledgeSpaces.name,
        })
        .from(knowledgePages)
        .innerJoin(knowledgeSpaces, eq(knowledgePages.spaceId, knowledgeSpaces.id));

    const visible = and(
      isNull(knowledgePages.deletedAt),
      isNull(knowledgeSpaces.deletedAt),
      sql`${knowledgeSpaces.visibility} != 'private'`,
    );

    return {
      byId: (id) => base().where(and(visible, eq(knowledgePages.id, id))),
      after: (afterId, limit) =>
        base()
          .where(afterId ? and(visible, gt(knowledgePages.id, afterId)) : visible)
          .orderBy(asc(knowledgePages.id))
          .limit(limit),
    };
  },
  toDocument: (r) => ({
    title: r.title || 'Untitled',
    subtitle: r.spaceName ?? null,
    content: compose([r.title, r.contentText]),
  }),
});

const articleLoader = defineLoader({
  type: 'article',
  select: (db) => {
    const { helpdeskArticles } = schema;
    const base = () =>
      db
        .select({
          id: helpdeskArticles.id,
          title: helpdeskArticles.title,
          excerpt: helpdeskArticles.excerpt,
          content: helpdeskArticles.content,
          categoryName: helpdeskArticles.categoryName,
        })
        .from(helpdeskArticles);
    const visible = isNull(helpdeskArticles.deletedAt);

    return {
      byId: (id) => base().where(and(visible, eq(helpdeskArticles.id, id))),
      after: (afterId, limit) =>
        base()
          .where(afterId ? and(visible, gt(helpdeskArticles.id, afterId)) : visible)
          .orderBy(asc(helpdeskArticles.id))
          .limit(limit),
    };
  },
  toDocument: (r) => ({
    title: r.title || 'Article',
    subtitle: r.categoryName ?? null,
    content: compose([r.title, r.excerpt, r.content]),
  }),
});

const ticketLoader = defineLoader({
  type: 'ticket',
  select: (db) => {
    const { helpdeskTickets } = schema;
    const base = () =>
      db
        .select({
          id: helpdeskTickets.id,
          subject: helpdeskTickets.subject,
          description: helpdeskTickets.description,
          ticketNumber: helpdeskTickets.ticketNumber,
          customerName: helpdeskTickets.customerName,
        })
        .from(helpdeskTickets);
    const visible = isNull(helpdeskTickets.deletedAt);

    return {
      byId: (id) => base().where(and(visible, eq(helpdeskTickets.id, id))),
      after: (afterId, limit) =>
        base()
          .where(afterId ? and(visible, gt(helpdeskTickets.id, afterId)) : visible)
          .orderBy(asc(helpdeskTickets.id))
          .limit(limit),
    };
  },
  toDocument: (r) => ({
    title: r.subject || `Ticket ${r.ticketNumber ?? ''}`.trim(),
    subtitle: r.ticketNumber ? `#${r.ticketNumber}` : (r.customerName ?? null),
    content: compose([r.subject, r.customerName, r.description]),
  }),
});

const projectLoader = defineLoader({
  type: 'project',
  select: (db) => {
    const { projects } = schema;
    const base = () =>
      db
        .select({
          id: projects.id,
          name: projects.name,
          code: projects.code,
          description: projects.description,
        })
        .from(projects);
    const visible = isNull(projects.deletedAt);

    return {
      byId: (id) => base().where(and(visible, eq(projects.id, id))),
      after: (afterId, limit) =>
        base()
          .where(afterId ? and(visible, gt(projects.id, afterId)) : visible)
          .orderBy(asc(projects.id))
          .limit(limit),
    };
  },
  toDocument: (r) => ({
    title: r.name || 'Project',
    subtitle: r.code ?? null,
    content: compose([r.name, r.code, r.description]),
  }),
});

const taskLoader = defineLoader({
  type: 'task',
  select: (db) => {
    const { tasks } = schema;
    const base = () =>
      db
        .select({
          id: tasks.id,
          title: tasks.title,
          number: tasks.number,
          description: tasks.description,
        })
        .from(tasks);
    const visible = isNull(tasks.deletedAt);

    return {
      byId: (id) => base().where(and(visible, eq(tasks.id, id))),
      after: (afterId, limit) =>
        base()
          .where(afterId ? and(visible, gt(tasks.id, afterId)) : visible)
          .orderBy(asc(tasks.id))
          .limit(limit),
    };
  },
  toDocument: (r) => ({
    title: r.title || 'Task',
    subtitle: r.number != null ? `TASK-${r.number}` : null,
    content: compose([r.title, r.description]),
  }),
});

const contactLoader = defineLoader({
  type: 'contact',
  select: (db) => {
    const { people } = schema;
    const base = () =>
      db
        .select({
          id: people.id,
          fullName: people.fullName,
          firstName: people.firstName,
          lastName: people.lastName,
          email: people.email,
          title: people.title,
        })
        .from(people);
    const visible = isNull(people.deletedAt);

    return {
      byId: (id) => base().where(and(visible, eq(people.id, id))),
      after: (afterId, limit) =>
        base()
          .where(afterId ? and(visible, gt(people.id, afterId)) : visible)
          .orderBy(asc(people.id))
          .limit(limit),
    };
  },
  toDocument: (r) => {
    const display =
      (r.fullName && r.fullName.trim()) ||
      [r.firstName, r.lastName].filter(Boolean).join(' ').trim() ||
      r.email ||
      '';
    if (!display) return null;
    return {
      title: display,
      subtitle: r.title || r.email || null,
      content: compose([display, r.title, r.email]),
    };
  },
});

const customerLoader = defineLoader({
  type: 'customer',
  select: (db) => {
    const { companies } = schema;
    const base = () =>
      db
        .select({
          id: companies.id,
          name: companies.name,
          tradingName: companies.tradingName,
          email: companies.email,
        })
        .from(companies);
    const visible = isNull(companies.deletedAt);

    return {
      byId: (id) => base().where(and(visible, eq(companies.id, id))),
      after: (afterId, limit) =>
        base()
          .where(afterId ? and(visible, gt(companies.id, afterId)) : visible)
          .orderBy(asc(companies.id))
          .limit(limit),
    };
  },
  toDocument: (r) => {
    const display = (r.name && r.name.trim()) || (r.tradingName && r.tradingName.trim()) || '';
    if (!display) return null;
    return {
      title: display,
      subtitle: r.tradingName && r.tradingName !== r.name ? r.tradingName : (r.email ?? null),
      content: compose([r.name, r.tradingName, r.email]),
    };
  },
});

const leadLoader = defineLoader({
  type: 'lead',
  select: (db) => {
    const { crmLeads } = schema;
    const base = () =>
      db
        .select({
          id: crmLeads.id,
          fullName: crmLeads.fullName,
          firstName: crmLeads.firstName,
          lastName: crmLeads.lastName,
          companyName: crmLeads.companyName,
          email: crmLeads.email,
        })
        .from(crmLeads);
    const visible = isNull(crmLeads.deletedAt);

    return {
      byId: (id) => base().where(and(visible, eq(crmLeads.id, id))),
      after: (afterId, limit) =>
        base()
          .where(afterId ? and(visible, gt(crmLeads.id, afterId)) : visible)
          .orderBy(asc(crmLeads.id))
          .limit(limit),
    };
  },
  toDocument: (r) => {
    const display =
      (r.fullName && r.fullName.trim()) ||
      [r.firstName, r.lastName].filter(Boolean).join(' ').trim() ||
      r.email ||
      '';
    if (!display) return null;
    return {
      title: display,
      subtitle: r.companyName || r.email || null,
      content: compose([display, r.companyName, r.email]),
    };
  },
});

const opportunityLoader = defineLoader({
  type: 'opportunity',
  select: (db) => {
    const { crmOpportunities } = schema;
    const base = () =>
      db
        .select({
          id: crmOpportunities.id,
          name: crmOpportunities.name,
          customerName: crmOpportunities.customerName,
          stage: crmOpportunities.stage,
        })
        .from(crmOpportunities);
    const visible = isNull(crmOpportunities.deletedAt);

    return {
      byId: (id) => base().where(and(visible, eq(crmOpportunities.id, id))),
      after: (afterId, limit) =>
        base()
          .where(afterId ? and(visible, gt(crmOpportunities.id, afterId)) : visible)
          .orderBy(asc(crmOpportunities.id))
          .limit(limit),
    };
  },
  toDocument: (r) => {
    if (!r.name) return null;
    return {
      title: r.name,
      subtitle: r.customerName || r.stage || null,
      content: compose([r.name, r.customerName, r.stage]),
    };
  },
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const DOCUMENT_LOADERS: DocumentLoader[] = [
  knowledgePageLoader,
  articleLoader,
  ticketLoader,
  projectLoader,
  taskLoader,
  contactLoader,
  customerLoader,
  leadLoader,
  opportunityLoader,
];

const LOADERS_BY_TYPE = new Map<SearchEntityType, DocumentLoader>(
  DOCUMENT_LOADERS.map((l) => [l.type, l]),
);

/** Entity types the semantic index covers. */
export const INDEXED_ENTITY_TYPES: SearchEntityType[] = DOCUMENT_LOADERS.map((l) => l.type);

export function getDocumentLoader(type: string): DocumentLoader | undefined {
  return LOADERS_BY_TYPE.get(type as SearchEntityType);
}

export function isIndexedEntityType(type: string): type is SearchEntityType {
  return LOADERS_BY_TYPE.has(type as SearchEntityType);
}

/**
 * Entity-event names that map onto an indexed search type.
 *
 * The two vocabularies overlap but are not identical: the event catalog emits
 * both `contact` and `person` for the `people` table, and `company` alongside
 * `customer` for `companies`. Both aliases have to land on the same index
 * entry or an update through one path would leave the other's rows stale.
 */
const EVENT_TYPE_ALIASES: Record<string, SearchEntityType> = {
  person: 'contact',
  company: 'customer',
};

/** Resolve an entity-event type onto the search type it indexes under. */
export function resolveIndexedType(eventEntityType: string): SearchEntityType | null {
  const aliased = EVENT_TYPE_ALIASES[eventEntityType] ?? eventEntityType;
  return isIndexedEntityType(aliased) ? aliased : null;
}
