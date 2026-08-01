/**
 * WeldObjects — record DATA routes (`/api/objects/:slug/records/*`).
 *
 * One generic route file serves every custom object a workspace ever creates.
 * There is no per-object code generation and no per-object deploy: `:slug` is
 * resolved per request by `requireCustomObject`, which also enforces the
 * dynamic `weldobjects:<slug>:<action>` permission and stashes the resolved
 * object on the context.
 *
 * Mutations publish `co_<slug>:<action>` entity events through
 * `publishCustomObjectEvent` — the one sanctioned bridge past the compile-time
 * event catalog. See @weldsuite/entity-events/custom-objects for why that
 * exists rather than a single shared `custom_object_record` entity type.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { publishCustomObjectEvent, computeChanges } from '@weldsuite/entity-events';
import {
  createCustomObjectRecordSchema,
  updateCustomObjectRecordSchema,
} from '@weldsuite/app-api-client/schemas/custom-objects';
import { CustomFieldValidationError } from '../../services/custom-field-values';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import {
  requireCustomObject,
  customObjectScope,
  getCustomObject,
} from '../../middleware/custom-object';
import {
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  updateRecord,
} from '../../services/custom-objects';
import {
  applyTargetDeleteCascade,
  buildTargetDeleteCascadeStatements,
} from '../../services/custom-object-links';
import { parseLimit, buildRecordDeleteStatements } from '@weldsuite/db/lib/custom-objects';
import { atomically } from '../../lib/atomically';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Pull `filter[custom:region]=EU` style params out of the raw query string.
 * Kept separate from the Zod schema because Hono surfaces bracketed params as
 * flat keys and a record schema can't express the bracket syntax.
 */
function parseFilters(query: Record<string, string>): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    const match = /^filter\[(.+)\]$/.exec(key);
    if (match?.[1]) filters[match[1]] = value;
  }
  return filters;
}

/** Only publish when the object has events switched on. */
function emit(
  c: Context<any, any, any>,
  object: ReturnType<typeof getCustomObject>,
  action: 'created' | 'updated' | 'deleted',
  entityId: string,
  data: Record<string, unknown>,
  changes?: Record<string, { old: unknown; new: unknown }> | null,
) {
  if (!object.enableEvents) return;
  publishCustomObjectEvent({
    c,
    entityKey: object.entityKey,
    action,
    entityId,
    data,
    changes,
  });
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

app.get('/:slug/records', requireCustomObject('read'), async (c) => {
  const db = c.get('tenantDb');
  const object = getCustomObject(c);
  const q = c.req.query();
  const scope = await customObjectScope(c);

  try {
    const result = await listRecords(db, object, {
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      search: q.search,
      ownerScope: scope,
      ownerId: q.ownerId,
      sort: q.sort,
      direction: q.direction === 'asc' ? 'asc' : 'desc',
      filters: parseFilters(q),
    });

    return list(
      c,
      result.data,
      cursorPagination(result.totalCount, result.hasMore, result.cursor),
    );
  } catch (err) {
    console.error(`[app-api/objects/${object.slug}] list failed:`, err);
    return error.internal(c, `Failed to list ${object.labelPlural.toLowerCase()}`);
  }
});

// ---------------------------------------------------------------------------
// Read one
// ---------------------------------------------------------------------------

app.get('/:slug/records/:id', requireCustomObject('read'), async (c) => {
  const db = c.get('tenantDb');
  const object = getCustomObject(c);
  const id = c.req.param('id');
  const scope = await customObjectScope(c);

  try {
    const record = await getRecord(db, object, id, scope);
    if (!record) return error.notFound(c, object.labelSingular, id);
    return success(c, record);
  } catch (err) {
    console.error(`[app-api/objects/${object.slug}] get failed:`, err);
    return error.internal(c, `Failed to fetch ${object.labelSingular.toLowerCase()}`);
  }
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

app.post(
  '/:slug/records',
  requireCustomObject('create'),
  zValidator('json', createCustomObjectRecordSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const object = getCustomObject(c);
    const data = c.req.valid('json');
    const userId = c.get('userId');

    try {
      const record = await createRecord(db, object, data, userId);
      emit(c, object, 'created', record.id, { ...record });
      return success(c, record, 201);
    } catch (err) {
      // Per-field type/required errors are the caller's fault, not ours —
      // surface the message instead of a generic 500.
      if (err instanceof CustomFieldValidationError) {
        return error.badRequest(c, err.message);
      }
      console.error(`[app-api/objects/${object.slug}] create failed:`, err);
      return error.internal(c, `Failed to create ${object.labelSingular.toLowerCase()}`);
    }
  },
);

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

app.patch(
  '/:slug/records/:id',
  requireCustomObject('update'),
  zValidator('json', updateCustomObjectRecordSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const object = getCustomObject(c);
    const id = c.req.param('id');
    const data = c.req.valid('json');
    const userId = c.get('userId');
    const scope = await customObjectScope(c);

    try {
      const existing = await getRecord(db, object, id, scope);
      if (!existing) return error.notFound(c, object.labelSingular, id);

      const updated = await updateRecord(db, object, existing, data, userId);

      // Diff the FIELD maps, not the record rows: `updatedAt`/`updatedBy`
      // change on every write and would make every event look like a change.
      const changes = computeChanges(
        existing.fields as Record<string, unknown>,
        updated.fields as Record<string, unknown>,
      );
      emit(c, object, 'updated', id, { ...updated }, changes);

      return success(c, updated);
    } catch (err) {
      if (err instanceof CustomFieldValidationError) {
        return error.badRequest(c, err.message);
      }
      console.error(`[app-api/objects/${object.slug}] update failed:`, err);
      return error.internal(c, `Failed to update ${object.labelSingular.toLowerCase()}`);
    }
  },
);

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

app.delete('/:slug/records/:id', requireCustomObject('delete'), async (c) => {
  const db = c.get('tenantDb');
  const object = getCustomObject(c);
  const id = c.req.param('id');
  const scope = await customObjectScope(c);

  try {
    const existing = await getRecord(db, object, id, scope);
    if (!existing) return error.notFound(c, object.labelSingular, id);

    // Plan the link cascade WITHOUT executing it. `onDelete` decides what
    // happens to records pointing at this one: `restrict` refuses the delete,
    // `cascade` takes the dependents with it, `set_null` just drops the edge.
    const cascade = await applyTargetDeleteCascade(db, object.entityKey, id, { dryRun: true });
    if (cascade.blockedBy.length > 0) {
      return error.conflict(
        c,
        `This ${object.labelSingular.toLowerCase()} still has ${cascade.blockedBy.join(', ')} linked to it. ` +
          `Unlink them first, or change the relationship's delete rule.`,
        { blockedBy: cascade.blockedBy },
      );
    }

    // Cascade and delete commit as ONE unit. Executing the cascade first and
    // then deleting meant a failure in the second step left the dependent
    // records soft-deleted while the record they depended on survived — an
    // inconsistency the caller saw only as a 500, with no way to recover them.
    const now = new Date();
    await atomically(db, (handle) => [
      ...buildTargetDeleteCascadeStatements(handle, cascade, object.entityKey, id, now),
      ...buildRecordDeleteStatements(handle, object, id, now),
    ]);
    emit(c, object, 'deleted', id, {
      id,
      title: existing.title,
      ...(cascade.cascadedRecordIds.length > 0
        ? { cascadedRecordIds: cascade.cascadedRecordIds }
        : {}),
    });

    return noContent(c);
  } catch (err) {
    console.error(`[app-api/objects/${object.slug}] delete failed:`, err);
    return error.internal(c, `Failed to delete ${object.labelSingular.toLowerCase()}`);
  }
});

export const customObjectRecordsRoutes = app;
