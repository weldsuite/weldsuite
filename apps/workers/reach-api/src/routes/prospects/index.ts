/**
 * Prospects: /api/reach/prospects
 *
 * Permissions: reach_prospects:read | create | update | delete. The CRM and
 * WeldData imports also need read access to the source (lists:read, plus
 * people:read for a CRM list).
 *
 * Imports store every parseable row with a `validation` verdict, report the
 * rows that cannot be used and why, and publish `reach_prospect:created` for
 * the first MAX_IMPORT_EVENTS new prospects (a 5 000-row import must not become
 * 5 000 queue messages inside one request).
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, or, ilike, type SQL } from 'drizzle-orm';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  importReachFromCrmListSchema,
  importReachFromWeldDataSchema,
  importReachProspectsSchema,
  reachProspectInputSchema,
  reachProspectValidationSchema,
  resolveWeldReachLimits,
  updateReachProspectSchema,
  type ReachImportReport,
} from '@weldsuite/app-api-client/schemas/reach';
import { reachProspectListMembers, reachProspects, type ReachProspect as ReachProspectRow } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { createList, findList } from '../../services/lists';
import { cursorCondition, likePattern, pageOf, parseLimit } from '../../services/list-query';
import {
  addProspectsToList,
  importProspects,
  loadCrmListRows,
  loadWeldDataListRows,
  softDeleteProspect,
  toProspect,
  type ImportOutcome,
  type ImportRow,
  type SourceListError,
} from '../../services/prospects';
import { completeAndPublish } from '../campaigns/events';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** Per-prospect events published by one import. */
export const MAX_IMPORT_EVENTS = 100;

/** appAccessGate sets `appAccess`; the optional chain keeps route tests that skip the gate working. */
function allowConsumer(c: AppContext): boolean {
  return resolveWeldReachLimits(c.get('appAccess')?.limits).allowConsumerRecipients;
}

function emitProspect(c: AppContext, action: 'created' | 'updated' | 'deleted', row: Pick<ReachProspectRow, 'id'> & Partial<ReachProspectRow>) {
  publishEntityEvent({ c, entityType: 'reach_prospect', action, entityId: row.id, data: row });
}

const blank = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

app.get('/', requirePermission('reach_prospects:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = parseLimit(q.limit);

  const conditions: SQL[] = [isNull(reachProspects.deletedAt)];
  if (q.search?.trim()) {
    const pattern = likePattern(q.search);
    const match = or(
      ilike(reachProspects.email, pattern),
      ilike(reachProspects.firstName, pattern),
      ilike(reachProspects.lastName, pattern),
      ilike(reachProspects.companyName, pattern),
    );
    if (match) conditions.push(match);
  }
  if (q.validation) {
    const parsed = reachProspectValidationSchema.safeParse(q.validation);
    if (!parsed.success) return error.badRequest(c, 'Unknown validation filter');
    conditions.push(eq(reachProspects.validation, parsed.data));
  }
  if (q.listId) {
    conditions.push(
      inArray(
        reachProspects.id,
        db.select({ id: reachProspectListMembers.prospectId }).from(reachProspectListMembers).where(eq(reachProspectListMembers.listId, q.listId)),
      ),
    );
  }

  const after = await cursorCondition(db, reachProspects, q.cursor);
  const [rows, total] = await Promise.all([
    db
      .select()
      .from(reachProspects)
      .where(and(...conditions, after))
      .orderBy(desc(reachProspects.createdAt), desc(reachProspects.id))
      .limit(limit + 1),
    db.$count(reachProspects, and(...conditions)),
  ]);
  const page = pageOf(rows, limit);
  return list(c, page.data.map(toProspect), cursorPagination(Number(total), page.hasMore, page.nextCursor));
});

app.get('/:id', requirePermission('reach_prospects:read'), async (c) => {
  const id = c.req.param('id');
  const [row] = await c
    .get('tenantDb')
    .select()
    .from(reachProspects)
    .where(and(eq(reachProspects.id, id), isNull(reachProspects.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Prospect', id);
  return success(c, toProspect(row));
});

app.post(
  '/',
  requirePermission('reach_prospects:create'),
  zValidator('json', reachProspectInputSchema.extend({ listId: z.string().min(1).max(30).optional() })),
  async (c) => {
    const db = c.get('tenantDb');
    const { listId, ...input } = c.req.valid('json');

    const [existing] = await db.select().from(reachProspects).where(eq(reachProspects.email, input.email)).limit(1);
    if (existing && !existing.deletedAt) return error.conflict(c, 'A prospect with this email already exists');
    if (listId && !(await findList(db, listId))) return error.notFound(c, 'List', listId);

    const outcome = await importProspects(db, [input], {
      source: 'manual',
      createdBy: c.get('userId'),
      allowConsumer: allowConsumer(c),
    });
    const stored = outcome.stored[0];
    if (!stored) return error.badRequest(c, 'The email address is not valid');
    if (listId) await addProspectsToList(db, listId, [stored.id]);

    const [row] = await db.select().from(reachProspects).where(eq(reachProspects.id, stored.id)).limit(1);
    if (!row) return error.internal(c, 'Failed to create the prospect');
    emitProspect(c, 'created', row);
    return success(c, toProspect(row), 201);
  },
);

app.patch('/:id', requirePermission('reach_prospects:update'), zValidator('json', updateReachProspectSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const input = c.req.valid('json');
  const [row] = await db
    .update(reachProspects)
    .set({
      ...(input.firstName !== undefined ? { firstName: blank(input.firstName) } : {}),
      ...(input.lastName !== undefined ? { lastName: blank(input.lastName) } : {}),
      ...(input.companyName !== undefined ? { companyName: blank(input.companyName) } : {}),
      ...(input.title !== undefined ? { title: blank(input.title) } : {}),
      ...(input.timezone !== undefined ? { timezone: blank(input.timezone) } : {}),
      ...(input.customFields !== undefined ? { customFields: input.customFields } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(reachProspects.id, id), isNull(reachProspects.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Prospect', id);
  emitProspect(c, 'updated', row);
  return success(c, toProspect(row));
});

app.delete('/:id', requirePermission('reach_prospects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const removed = await softDeleteProspect(db, id);
  if (!removed) return error.notFound(c, 'Prospect', id);
  await completeAndPublish(c, db, removed.campaignIds);
  emitProspect(c, 'deleted', { id });
  return noContent(c);
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

interface ImportTarget {
  /** An existing list to add to. */
  listId?: string;
  /** Or a list to create. */
  listName?: string;
}

/** Resolve (or create) the list an import adds to; a response when the list does not exist. */
async function resolveImportList(
  c: AppContext,
  target: ImportTarget,
  list: { source: 'csv' | 'crm_list' | 'welddata'; sourceRef: string | null },
): Promise<{ listId: string | null } | { response: Response }> {
  const db = c.get('tenantDb');
  if (target.listId) {
    if (!(await findList(db, target.listId))) return { response: error.notFound(c, 'List', target.listId) };
    return { listId: target.listId };
  }
  if (target.listName) {
    const created = await createList(db, {
      name: target.listName,
      source: list.source,
      sourceRef: list.sourceRef,
      createdBy: c.get('userId'),
    });
    return { listId: created.id };
  }
  return { listId: null };
}

async function finishImport(
  c: AppContext,
  outcome: ImportOutcome,
  listId: string | null,
): Promise<ReachImportReport> {
  const db = c.get('tenantDb');
  if (listId) await addProspectsToList(db, listId, outcome.stored.map((s) => s.id));

  const fresh = outcome.stored.filter((s) => s.isNew).slice(0, MAX_IMPORT_EVENTS);
  if (fresh.length > 0) {
    const rows = await db
      .select()
      .from(reachProspects)
      .where(inArray(reachProspects.id, fresh.map((s) => s.id)));
    for (const row of rows) emitProspect(c, 'created', row);
  }
  return { listId, created: outcome.created, updated: outcome.updated, skipped: outcome.skipped };
}

const SOURCE_ERRORS: Record<SourceListError, string> = {
  not_found: 'List not found',
  wrong_kind: 'Only lists of people can be imported',
  smart_list: 'Smart lists cannot be imported; use a static list',
  too_large: 'This list is too large to import at once',
};

app.post('/import', requirePermission('reach_prospects:create'), zValidator('json', importReachProspectsSchema), async (c) => {
  const db = c.get('tenantDb');
  const input = c.req.valid('json');
  const target = await resolveImportList(c, input, { source: 'csv', sourceRef: input.sourceRef ?? null });
  if ('response' in target) return target.response;

  const rows: ImportRow[] = input.rows;
  const outcome = await importProspects(db, rows, {
    source: 'csv',
    sourceRef: input.sourceRef ?? null,
    createdBy: c.get('userId'),
    allowConsumer: allowConsumer(c),
  });
  return success(c, await finishImport(c, outcome, target.listId));
});

app.post(
  '/import-crm-list',
  requirePermission('reach_prospects:create'),
  zValidator('json', importReachFromCrmListSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const input = c.req.valid('json');
    if (!(await hasContextPermission(c, 'lists:read')) || !(await hasContextPermission(c, 'people:read'))) {
      return error.forbidden(c, 'Importing a CRM list needs read access to CRM lists and people');
    }

    const source = await loadCrmListRows(db, input.crmListId);
    if (!source.ok) {
      return source.error === 'not_found' ? error.notFound(c, 'CRM list', input.crmListId) : error.badRequest(c, SOURCE_ERRORS[source.error]);
    }
    const target = await resolveImportList(c, { listName: input.listName ?? source.name }, { source: 'crm_list', sourceRef: input.crmListId });
    if ('response' in target) return target.response;

    const outcome = await importProspects(db, source.rows, {
      source: 'crm_list',
      sourceRef: input.crmListId,
      createdBy: c.get('userId'),
      allowConsumer: allowConsumer(c),
    });
    return success(c, await finishImport(c, outcome, target.listId));
  },
);

app.post(
  '/import-welddata',
  requirePermission('reach_prospects:create'),
  zValidator('json', importReachFromWeldDataSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const input = c.req.valid('json');
    if (!(await hasContextPermission(c, 'lists:read'))) {
      return error.forbidden(c, 'Importing a WeldData list needs read access to its lists');
    }

    const source = await loadWeldDataListRows(db, input.welddataListId);
    if (!source.ok) {
      return source.error === 'not_found'
        ? error.notFound(c, 'WeldData list', input.welddataListId)
        : error.badRequest(c, SOURCE_ERRORS[source.error]);
    }
    const target = await resolveImportList(
      c,
      { listName: input.listName ?? source.name },
      { source: 'welddata', sourceRef: input.welddataListId },
    );
    if ('response' in target) return target.response;

    const outcome = await importProspects(db, source.rows, {
      source: 'welddata',
      sourceRef: input.welddataListId,
      createdBy: c.get('userId'),
      allowConsumer: allowConsumer(c),
    });
    return success(c, await finishImport(c, outcome, target.listId));
  },
);

export default app;
