/**
 * WeldObjects — resolving link TARGETS to displayable references.
 *
 * A relationship edge stores `(targetEntityKey, targetId)` and nothing else, so
 * rendering a related panel means turning those pairs back into "Acme
 * Industries" or "Ticket #412: printer jam". This module owns that mapping for
 * built-in entities; custom object targets resolve through
 * `custom_object_records.title` instead and never come here.
 *
 * The registry below is an ALLOW-LIST, and deliberately so. `targetEntityKey`
 * originates from user input when a link is defined, and a polymorphic lookup
 * driven by an arbitrary user-supplied table name is both a broken-reference
 * generator and an information-disclosure surface. Every entry here must also
 * appear in LINKABLE_BUILTIN_ENTITY_TYPES in
 * @weldsuite/app-api-client/schemas/custom-objects — the Zod schema rejects
 * anything else at the API boundary, and this registry is the second gate.
 *
 * Adding a new linkable entity is one entry here plus one in that array.
 */

import { inArray, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { customObjectSlugFromEntityKey } from '@weldsuite/entity-events';
import { customObjectPermission } from '@weldsuite/permissions/custom-objects';
import { schema } from '../db';
import type { Database } from '../db';

export interface ResolvedTarget {
  id: string;
  entityType: string;
  title: string;
  /** Platform route for the record, so panels can link straight to it. */
  href: string;
}

/**
 * The minimum a linkable table must expose. Typed rather than `any` so a
 * renamed column — `crmQuotes.quoteNumber`, say — fails at build time instead
 * of throwing on the first request that resolves that target.
 *
 * `deletedAt` is optional because the accessor below has to be able to ASK
 * whether it exists; the registry's `softDeletes` flag is then checked against
 * reality at runtime.
 */
type LinkableTable = PgTable & {
  id: AnyPgColumn;
  deletedAt?: AnyPgColumn;
};

interface TargetDefinition<T extends LinkableTable = LinkableTable> {
  /** The Drizzle table. */
  table: T;
  /** Column holding the human-readable label. */
  titleColumn: (t: T) => AnyPgColumn;
  /** Secondary column tried when the primary is null. */
  fallbackColumn?: (t: T) => AnyPgColumn;
  /** Singular label used in the link editor. */
  label: string;
  /**
   * Permission required to see records of this type.
   *
   * Linking is a read of the TARGET as much as a write to the source: a related
   * panel resolves and displays the target's title. Without this, a user with
   * `weldobjects:machine:update` could attach a Machine to any Customer id and
   * read that customer's name back out of the panel, with no `companies:read`.
   */
  readPermission: string;
  /** Platform route builder. */
  href: (id: string) => string;
  /** Whether the table soft-deletes; controls the deletedAt filter. */
  softDeletes: boolean;
}

/**
 * Registry entry factory.
 *
 * Exists purely so each entry's accessors are checked against ITS OWN table
 * type: `Record<string, TargetDefinition>` would collapse every entry to the
 * base type and `(t) => t.quoteNumber` would stop being verified. One
 * contained cast on the way out buys build-time checking at all twelve call
 * sites — a renamed column now fails `tsc` instead of throwing on the first
 * request that resolves that target.
 */
function defineTarget<T extends LinkableTable>(def: TargetDefinition<T>): TargetDefinition {
  return def as unknown as TargetDefinition;
}

const TARGETS: Record<string, TargetDefinition> = {
  company: defineTarget({
    table: schema.companies,
    titleColumn: (t) => t.name,
    fallbackColumn: (t) => t.displayName,
    readPermission: 'companies:read',
    label: 'Company',
    href: (id) => `/crm/companies/${id}`,
    softDeletes: true,
  }),
  person: defineTarget({
    table: schema.people,
    titleColumn: (t) => t.fullName,
    fallbackColumn: (t) => t.displayName,
    readPermission: 'people:read',
    label: 'Person',
    href: (id) => `/crm/people/${id}`,
    softDeletes: true,
  }),
  lead: defineTarget({
    table: schema.crmLeads,
    titleColumn: (t) => t.fullName,
    fallbackColumn: (t) => t.email,
    readPermission: 'leads:read',
    label: 'Lead',
    href: (id) => `/crm/leads/${id}`,
    softDeletes: true,
  }),
  opportunity: defineTarget({
    table: schema.crmOpportunities,
    titleColumn: (t) => t.name,
    readPermission: 'opportunities:read',
    label: 'Deal',
    href: (id) => `/crm/opportunities/${id}`,
    softDeletes: true,
  }),
  quote: defineTarget({
    table: schema.crmQuotes,
    titleColumn: (t) => t.name,
    fallbackColumn: (t) => t.quoteNumber,
    readPermission: 'quotes:read',
    label: 'Quote',
    href: (id) => `/crm/quotes/${id}`,
    softDeletes: true,
  }),
  ticket: defineTarget({
    table: schema.helpdeskTickets,
    titleColumn: (t) => t.subject,
    readPermission: 'tickets:read',
    label: 'Ticket',
    href: (id) => `/welddesk/tickets/${id}`,
    softDeletes: true,
  }),
  conversation: defineTarget({
    table: schema.deskConversations,
    titleColumn: (t) => t.title,
    readPermission: 'conversations:read',
    label: 'Conversation',
    href: (id) => `/welddesk/inbox/${id}`,
    softDeletes: false,
  }),
  project: defineTarget({
    table: schema.projects,
    titleColumn: (t) => t.name,
    readPermission: 'projects:read',
    label: 'Project',
    href: (id) => `/weldflow/projects/${id}`,
    softDeletes: true,
  }),
  task: defineTarget({
    table: schema.tasks,
    titleColumn: (t) => t.title,
    readPermission: 'tasks:read',
    label: 'Task',
    href: (id) => `/weldflow/tasks/${id}`,
    softDeletes: true,
  }),
  product: defineTarget({
    table: schema.products,
    titleColumn: (t) => t.name,
    readPermission: 'products:read',
    label: 'Product',
    href: (id) => `/commerce/products/${id}`,
    softDeletes: true,
  }),
  order: defineTarget({
    table: schema.orders,
    titleColumn: (t) => t.orderNumber,
    readPermission: 'orders:read',
    label: 'Order',
    href: (id) => `/commerce/orders/${id}`,
    softDeletes: true,
  }),
  invoice: defineTarget({
    table: schema.invoices,
    titleColumn: (t) => t.invoiceNumber,
    readPermission: 'invoices:read',
    label: 'Invoice',
    href: (id) => `/weldbooks/invoices/${id}`,
    softDeletes: true,
  }),
};

export function isLinkableBuiltin(entityType: string): boolean {
  return Object.hasOwn(TARGETS, entityType);
}

export function builtinTargetLabel(entityType: string): string | null {
  return TARGETS[entityType]?.label ?? null;
}

/**
 * Permission needed to read records of a link target.
 *
 * Built-ins map to their own object permission; custom objects map to
 * `weldobjects:<slug>:read`. Returns null for an unknown type, which callers
 * must treat as "deny" rather than "no check required".
 */
export function targetReadPermission(targetEntityKey: string): string | null {
  const builtin = TARGETS[targetEntityKey];
  if (builtin) return builtin.readPermission;

  const slug = customObjectSlugFromEntityKey(targetEntityKey);
  return slug ? customObjectPermission(slug, 'read') : null;
}

export function listLinkableBuiltins(): Array<{ entityType: string; label: string }> {
  return Object.entries(TARGETS).map(([entityType, def]) => ({
    entityType,
    label: def.label,
  }));
}

/**
 * Resolve a batch of built-in records of ONE entity type to displayable refs.
 *
 * Returns a map keyed by id. Ids that don't resolve — deleted, or never existed
 * because an edge outlived its target — are simply absent, and callers drop
 * them. That is the intended behaviour: a related panel showing a dangling
 * reference to a record the user can't open is worse than showing nothing.
 */
export async function resolveBuiltinTargets(
  db: Database,
  entityType: string,
  ids: string[],
): Promise<Record<string, ResolvedTarget>> {
  const out: Record<string, ResolvedTarget> = {};
  const def = TARGETS[entityType];
  if (!def || ids.length === 0) return out;

  const table = def.table;
  const titleCol = def.titleColumn(table);
  const fallbackCol = def.fallbackColumn?.(table);

  const selection: Record<string, unknown> = { id: table.id, title: titleCol };
  if (fallbackCol) selection.fallback = fallbackCol;

  const conditions = [inArray(table.id, ids)];
  if (def.softDeletes) {
    // Throw rather than skip. `def.softDeletes && table.deletedAt` would
    // silently drop the filter if a table lacked the column, and the symptom
    // is deleted records resurfacing as live link targets — a data-correctness
    // bug that looks like nothing at all. A registry entry that lies about its
    // table should fail loudly, on the first request, in dev.
    if (!table.deletedAt) {
      throw new Error(
        `[custom-object-targets] '${entityType}' declares softDeletes but its table has no deletedAt column`,
      );
    }
    conditions.push(sql`${table.deletedAt} IS NULL`);
  }

  const rows = (await db
    .select(selection as never)
    .from(table)
    .where(sql.join(conditions, sql` AND `))) as Array<{
    id: string;
    title: string | null;
    fallback?: string | null;
  }>;

  for (const row of rows) {
    out[row.id] = {
      id: row.id,
      entityType,
      title: row.title || row.fallback || row.id,
      href: def.href(row.id),
    };
  }
  return out;
}

/**
 * Resolve targets spanning MULTIPLE entity types — one query per distinct type
 * rather than one per row.
 */
export async function resolveBuiltinTargetsMixed(
  db: Database,
  refs: Array<{ entityType: string; id: string }>,
): Promise<Record<string, ResolvedTarget>> {
  const byType = new Map<string, string[]>();
  for (const ref of refs) {
    if (!isLinkableBuiltin(ref.entityType)) continue;
    const list = byType.get(ref.entityType) ?? [];
    list.push(ref.id);
    byType.set(ref.entityType, list);
  }

  const results = await Promise.all(
    [...byType.entries()].map(([entityType, ids]) =>
      resolveBuiltinTargets(db, entityType, ids),
    ),
  );

  const out: Record<string, ResolvedTarget> = {};
  for (const chunk of results) Object.assign(out, chunk);
  return out;
}
