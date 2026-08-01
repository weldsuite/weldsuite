/**
 * WeldObjects — relationship definitions and edges.
 *
 * ## To-one enforcement lives here, and only here
 *
 * `custom_object_relations` holds edges for all four cardinalities in one
 * table. A partial unique index cannot express "unique per source, but only
 * when the parent link is to-one", because cardinality lives on the LINK row,
 * not the edge row. So the constraint is enforced in `attach()` below.
 *
 * That makes `attach()` the single legal way to create an edge. Do not inline
 * an insert into `custom_object_relations` anywhere else — doing so silently
 * bypasses the only thing keeping a many_to_one link from accumulating six
 * parents.
 *
 * ## Cascade
 *
 * `onDelete` describes what happens to the SOURCE side when a TARGET record is
 * deleted:
 *   restrict  — refuse the delete while edges exist
 *   cascade   — delete the source custom object records too
 *   set_null  — drop the edge, keep the source record (default)
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { generateId } from '../lib/id';
import { atomically } from '../lib/atomically';
import { schema } from '../db';
import type { Database } from '../db';
import {
  isLinkableBuiltin,
  resolveBuiltinTargets,
  type ResolvedTarget,
} from './custom-object-targets';

const links = schema.customObjectLinks;
const relations = schema.customObjectRelations;
const records = schema.customObjectRecords;
const objects = schema.customObjects;

export type CustomObjectLinkRow = typeof links.$inferSelect;

export class LinkCardinalityError extends Error {}
export class LinkTargetError extends Error {}

const TO_ONE: readonly string[] = ['one_to_one', 'many_to_one'];

// ---------------------------------------------------------------------------
// Link definitions
// ---------------------------------------------------------------------------

export async function listLinksForObject(
  db: Database,
  entityKey: string,
): Promise<CustomObjectLinkRow[]> {
  return db
    .select()
    .from(links)
    .where(and(eq(links.sourceEntityKey, entityKey), isNull(links.deletedAt)))
    .orderBy(asc(links.sortOrder), asc(links.targetLabel));
}

/** Links pointing AT this entity key — drives reverse related panels. */
export async function listLinksTargeting(
  db: Database,
  entityKey: string,
): Promise<CustomObjectLinkRow[]> {
  return db
    .select()
    .from(links)
    .where(and(eq(links.targetEntityKey, entityKey), isNull(links.deletedAt)))
    .orderBy(asc(links.sortOrder), asc(links.sourceLabel));
}

export async function getLinkBySlug(
  db: Database,
  sourceEntityKey: string,
  slug: string,
): Promise<CustomObjectLinkRow | null> {
  const [row] = await db
    .select()
    .from(links)
    .where(
      and(
        eq(links.sourceEntityKey, sourceEntityKey),
        eq(links.slug, slug),
        isNull(links.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Validate that a link's target actually exists as a linkable thing — either a
 * built-in on the allow-list, or a live custom object. Without this a typo in
 * the link editor produces a relationship that can never resolve anything.
 */
export async function assertValidTarget(db: Database, targetEntityKey: string): Promise<void> {
  if (isLinkableBuiltin(targetEntityKey)) return;

  const [obj] = await db
    .select({ id: objects.id })
    .from(objects)
    .where(and(eq(objects.entityKey, targetEntityKey), isNull(objects.deletedAt)))
    .limit(1);

  if (!obj) {
    throw new LinkTargetError(
      `'${targetEntityKey}' is not a linkable entity — it is neither a supported built-in nor an existing custom object`,
    );
  }
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/**
 * Create an edge, enforcing the parent link's cardinality.
 *
 * For a to-one link an existing edge from the same source is REPLACED rather
 * than rejected: "set this machine's customer" is the operation users actually
 * mean, and making them detach first would be ceremony. For to-many links the
 * unique index on `(linkId, sourceId, targetId)` makes a repeat attach a no-op.
 */
export async function attach(
  db: Database,
  link: CustomObjectLinkRow,
  sourceId: string,
  targetId: string,
  userId: string,
): Promise<void> {
  // one_to_one additionally constrains the TARGET side — a target may not be
  // claimed by two different sources.
  if (link.cardinality === 'one_to_one') {
    const [taken] = await db
      .select({ id: relations.id, sourceId: relations.sourceId })
      .from(relations)
      .where(and(eq(relations.linkId, link.id), eq(relations.targetId, targetId)))
      .limit(1);
    if (taken && taken.sourceId !== sourceId) {
      throw new LinkCardinalityError(
        `This ${link.targetLabel.toLowerCase()} is already linked to another record and the relationship is one-to-one`,
      );
    }
  }

  const [existing] = await db
    .select({ id: relations.id })
    .from(relations)
    .where(
      and(
        eq(relations.linkId, link.id),
        eq(relations.sourceId, sourceId),
        eq(relations.targetId, targetId),
      ),
    )
    .limit(1);
  if (existing) return;

  // The to-one replace and the insert commit together. Deleting first as a
  // separate statement would lose the previous edge outright if the insert then
  // failed — the relationship would simply vanish, with the caller seeing a
  // 500 and no way to tell what it had been.
  //
  // Residual race, deliberately not papered over: two concurrent one-to-one
  // attaches can both pass the target check above before either inserts.
  // Closing that needs a partial unique index on (link_id, target_id) for
  // to-one links, which this table can't express because cardinality lives on
  // the link row. It is a lost-update on a hand-driven admin action, not a
  // correctness hole in the data model.
  await atomically(db, (handle) => {
    const statements: unknown[] = [];
    if (TO_ONE.includes(link.cardinality)) {
      statements.push(
        handle
          .delete(relations)
          .where(and(eq(relations.linkId, link.id), eq(relations.sourceId, sourceId))),
      );
    }
    statements.push(
      handle.insert(relations).values({
        id: generateId('corl'),
        linkId: link.id,
        sourceEntityKey: link.sourceEntityKey,
        sourceId,
        targetEntityKey: link.targetEntityKey,
        targetId,
        createdBy: userId,
        createdAt: new Date(),
      }),
    );
    return statements;
  });
}

export async function detach(
  db: Database,
  link: CustomObjectLinkRow,
  sourceId: string,
  targetId: string,
): Promise<void> {
  await db
    .delete(relations)
    .where(
      and(
        eq(relations.linkId, link.id),
        eq(relations.sourceId, sourceId),
        eq(relations.targetId, targetId),
      ),
    );
}

export interface RelatedEntry extends ResolvedTarget {
  /** Edge id, so the UI can detach without recomputing the pair. */
  relationId: string;
}

/**
 * Everything a source record is linked to through one link.
 *
 * Resolves titles for both flavours of target: custom object records read their
 * denormalized `title`, built-ins go through the target registry. Unresolvable
 * ids are dropped rather than rendered as dangling references.
 */
export async function listRelated(
  db: Database,
  link: CustomObjectLinkRow,
  sourceId: string,
): Promise<RelatedEntry[]> {
  const edges = await db
    .select()
    .from(relations)
    .where(and(eq(relations.linkId, link.id), eq(relations.sourceId, sourceId)))
    .orderBy(asc(relations.sortOrder), asc(relations.createdAt));

  if (edges.length === 0) return [];
  const targetIds = edges.map((e) => e.targetId);

  const resolved = link.targetEntityKey.startsWith('co_')
    ? await resolveCustomObjectTargets(db, link.targetEntityKey, targetIds)
    : await resolveBuiltinTargets(db, link.targetEntityKey, targetIds);

  const out: RelatedEntry[] = [];
  for (const edge of edges) {
    const target = resolved[edge.targetId];
    if (!target) continue;
    out.push({ ...target, relationId: edge.id });
  }
  return out;
}

/** Custom object records resolve through their denormalized title. */
async function resolveCustomObjectTargets(
  db: Database,
  entityKey: string,
  ids: string[],
): Promise<Record<string, ResolvedTarget>> {
  const out: Record<string, ResolvedTarget> = {};
  if (ids.length === 0) return out;

  const [obj] = await db
    .select({ slug: objects.slug })
    .from(objects)
    .where(and(eq(objects.entityKey, entityKey), isNull(objects.deletedAt)))
    .limit(1);
  if (!obj) return out;

  const rows = await db
    .select({ id: records.id, title: records.title })
    .from(records)
    .where(
      and(
        eq(records.entityKey, entityKey),
        inArray(records.id, ids),
        isNull(records.deletedAt),
      ),
    );

  for (const row of rows) {
    out[row.id] = {
      id: row.id,
      entityType: entityKey,
      title: row.title ?? row.id,
      href: `/objects/${obj.slug}/${row.id}`,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reverse lookup
// ---------------------------------------------------------------------------

export interface ReversePanel {
  linkId: string;
  linkSlug: string;
  /** Heading for the panel on the TARGET's page — "Machines". */
  label: string;
  /** The custom object the related records belong to. */
  objectSlug: string;
  objectLabelPlural: string;
  records: Array<{ id: string; title: string; href: string; relationId: string }>;
}

/**
 * Every custom object record linked TO a given record, grouped by link.
 *
 * This is what lets a Customer detail page grow a "Machines" panel without CRM
 * code knowing custom objects exist. It rides the
 * `(target_entity_key, target_id)` index, so it costs one indexed scan
 * regardless of how many links a workspace has defined.
 */
export async function listReversePanels(
  db: Database,
  targetEntityKey: string,
  targetId: string,
): Promise<ReversePanel[]> {
  const edges = await db
    .select()
    .from(relations)
    .where(
      and(eq(relations.targetEntityKey, targetEntityKey), eq(relations.targetId, targetId)),
    );
  if (edges.length === 0) return [];

  const linkIds = [...new Set(edges.map((e) => e.linkId))];
  const linkRows = await db
    .select()
    .from(links)
    .where(and(inArray(links.id, linkIds), isNull(links.deletedAt)));
  const linkById = new Map(linkRows.map((l) => [l.id, l]));

  const sourceKeys = [...new Set(linkRows.map((l) => l.sourceEntityKey))];
  const objectRows = sourceKeys.length
    ? await db
        .select()
        .from(objects)
        .where(and(inArray(objects.entityKey, sourceKeys), isNull(objects.deletedAt)))
    : [];
  const objectByKey = new Map(objectRows.map((o) => [o.entityKey, o]));

  const sourceIds = [...new Set(edges.map((e) => e.sourceId))];
  const recordRows = sourceIds.length
    ? await db
        .select({ id: records.id, title: records.title, entityKey: records.entityKey })
        .from(records)
        .where(and(inArray(records.id, sourceIds), isNull(records.deletedAt)))
    : [];
  const recordById = new Map(recordRows.map((r) => [r.id, r]));

  const panels = new Map<string, ReversePanel>();
  for (const edge of edges) {
    const link = linkById.get(edge.linkId);
    if (!link) continue;
    const object = objectByKey.get(link.sourceEntityKey);
    if (!object) continue;
    const record = recordById.get(edge.sourceId);
    if (!record) continue;

    let panel = panels.get(link.id);
    if (!panel) {
      panel = {
        linkId: link.id,
        linkSlug: link.slug,
        label: link.sourceLabel,
        objectSlug: object.slug,
        objectLabelPlural: object.labelPlural,
        records: [],
      };
      panels.set(link.id, panel);
    }
    panel.records.push({
      id: record.id,
      title: record.title ?? record.id,
      href: `/objects/${object.slug}/${record.id}`,
      relationId: edge.id,
    });
  }

  return [...panels.values()];
}

// ---------------------------------------------------------------------------
// Cascade on target deletion
// ---------------------------------------------------------------------------

export interface CascadeResult {
  /** Edges removed. */
  detached: number;
  /** Custom object record ids deleted by a `cascade` link. */
  cascadedRecordIds: string[];
  /** Link labels that blocked the delete because they are `restrict`. */
  blockedBy: string[];
}

/**
 * Apply link `onDelete` rules when a target record is deleted.
 *
 * Call this BEFORE deleting the target and honour `blockedBy`: a non-empty
 * `blockedBy` means at least one `restrict` link still has edges, and the
 * delete must be refused.
 *
 * Note this is only reached for deletions that route through code aware of it.
 * A built-in record deleted by a route that doesn't call this leaves edges
 * behind — which is why `listRelated` and `listReversePanels` both drop
 * unresolvable ids instead of trusting the edge table.
 */
export async function applyTargetDeleteCascade(
  db: Database,
  targetEntityKey: string,
  targetId: string,
  opts: { dryRun?: boolean } = {},
): Promise<CascadeResult> {
  const edges = await db
    .select()
    .from(relations)
    .where(
      and(eq(relations.targetEntityKey, targetEntityKey), eq(relations.targetId, targetId)),
    );

  const result: CascadeResult = { detached: 0, cascadedRecordIds: [], blockedBy: [] };
  if (edges.length === 0) return result;

  const linkIds = [...new Set(edges.map((e) => e.linkId))];
  const linkRows = await db
    .select()
    .from(links)
    .where(and(inArray(links.id, linkIds), isNull(links.deletedAt)));
  const linkById = new Map(linkRows.map((l) => [l.id, l]));

  for (const edge of edges) {
    const link = linkById.get(edge.linkId);
    if (!link) continue;
    if (link.onDelete === 'restrict') {
      if (!result.blockedBy.includes(link.sourceLabel)) result.blockedBy.push(link.sourceLabel);
    } else if (link.onDelete === 'cascade') {
      result.cascadedRecordIds.push(edge.sourceId);
    }
  }

  if (result.blockedBy.length > 0 || opts.dryRun) return result;

  if (result.cascadedRecordIds.length > 0) {
    const now = new Date();
    await db
      .update(records)
      .set({ deletedAt: now, updatedAt: now })
      .where(inArray(records.id, result.cascadedRecordIds));
  }

  const deleted = await db
    .delete(relations)
    .where(
      and(eq(relations.targetEntityKey, targetEntityKey), eq(relations.targetId, targetId)),
    );
  result.detached = edges.length;
  void deleted;

  return result;
}

/**
 * The writes {@link applyTargetDeleteCascade} would perform, returned
 * unexecuted so the caller can commit them together with the target's own
 * delete. Pair with a `dryRun: true` plan from `applyTargetDeleteCascade`.
 */
export function buildTargetDeleteCascadeStatements(
  handle: Database,
  plan: CascadeResult,
  targetEntityKey: string,
  targetId: string,
  now = new Date(),
): unknown[] {
  const statements: unknown[] = [];

  if (plan.cascadedRecordIds.length > 0) {
    statements.push(
      handle
        .update(records)
        .set({ deletedAt: now, updatedAt: now })
        .where(inArray(records.id, plan.cascadedRecordIds)),
    );
  }

  statements.push(
    handle
      .delete(relations)
      .where(
        and(eq(relations.targetEntityKey, targetEntityKey), eq(relations.targetId, targetId)),
      ),
  );

  return statements;
}

/**
 * Links with `onDelete: 'restrict'` that would be violated by deleting this
 * object type, i.e. links pointing AT it that still have live edges.
 *
 * `deleteCustomObjectCascade` wipes every matching edge unconditionally, so
 * without this check `restrict` was enforced when deleting a single RECORD but
 * silently ignored when deleting the whole object — the stricter operation had
 * the weaker guarantee. Returns the source-side labels, for the error message.
 */
export async function findRestrictingLinks(
  db: Database,
  entityKey: string,
): Promise<string[]> {
  const restricting = await db
    .select({ id: links.id, sourceLabel: links.sourceLabel })
    .from(links)
    .where(
      and(
        eq(links.targetEntityKey, entityKey),
        eq(links.onDelete, 'restrict'),
        isNull(links.deletedAt),
      ),
    );
  if (restricting.length === 0) return [];

  // Only links that actually hold edges block the delete — a `restrict` link
  // with nothing attached has nothing to protect.
  const withEdges = await db
    .select({ linkId: relations.linkId })
    .from(relations)
    .where(
      inArray(
        relations.linkId,
        restricting.map((l) => l.id),
      ),
    )
    .groupBy(relations.linkId);

  const blocking = new Set(withEdges.map((r) => r.linkId));
  return restricting.filter((l) => blocking.has(l.id)).map((l) => l.sourceLabel);
}

/** Count of edges per source record for a link — used to render panel badges. */
export async function countRelated(
  db: Database,
  linkId: string,
  sourceIds: string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const id of sourceIds) out[id] = 0;
  if (sourceIds.length === 0) return out;

  const rows = await db
    .select({ sourceId: relations.sourceId, count: sql<number>`count(*)` })
    .from(relations)
    .where(and(eq(relations.linkId, linkId), inArray(relations.sourceId, sourceIds)))
    .groupBy(relations.sourceId);

  for (const row of rows) out[row.sourceId] = Number(row.count ?? 0);
  return out;
}
