/**
 * WeldObjects — object TYPE definition routes (`/api/custom-objects/*`).
 *
 * This is the admin surface: creating object types, renaming them, toggling
 * their integrations, deleting them. All of it sits behind
 * `weldobjects:manage`, which is a settings-grade permission — it can destroy
 * every record in an object.
 *
 * Record CRUD is a DIFFERENT surface (`/api/objects/:slug/records`) behind
 * per-object permissions. See ../custom-object-records/.
 *
 * There are deliberately no FIELD routes here. A custom object's fields are
 * ordinary `custom_field_definitions` rows, so `/api/custom-fields` already
 * handles them — pass `entityType=co_<slug>`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createCustomObjectSchema,
  updateCustomObjectSchema,
  reorderCustomObjectsSchema,
} from '@weldsuite/app-api-client/schemas/custom-objects';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import {
  deleteCustomObjectCascade,
  entityKeyForSlug,
  getCustomObjectCounts,
  getDeleteImpact,
  listCustomObjects,
} from '../../services/custom-objects';
import { clearCustomObjectIndex } from '../../services/search/custom-object-documents';
import { atomically } from '../../lib/atomically';
import { findRestrictingLinks } from '../../services/custom-object-links';
import { isUniqueViolation } from '../../lib/pg-errors';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.customObjects;

/**
 * Object types are workspace metadata that the sidebar renders for everyone, so
 * LISTING them only needs `weldobjects:read`. Everything that changes a
 * definition needs `weldobjects:manage`.
 */
app.get(
  '/',
  requirePermission('weldobjects:read', 'weldobjects:manage'),
  zValidator('query', z.object({ status: z.string().optional() })),
  async (c) => {
    const db = c.get('tenantDb');
    const { status } = c.req.valid('query');

    try {
      const rows = await listCustomObjects(db, { status });
      const counts = await getCustomObjectCounts(db, rows.map((r) => r.entityKey));
      const data = rows.map((r) => ({
        ...r,
        recordCount: counts[r.entityKey]?.recordCount ?? 0,
        fieldCount: counts[r.entityKey]?.fieldCount ?? 0,
      }));
      // Uses the list envelope even though object definitions are never
      // paginated (a workspace has tens, not thousands). A client that reads
      // `pagination` from every list endpoint shouldn't have to special-case
      // this one. `cursor: null` says plainly that there is no next page.
      return list(c, data, cursorPagination(data.length, false, null));
    } catch (err) {
      console.error('[app-api/custom-objects] list failed:', err);
      return error.internal(c, 'Failed to list custom objects');
    }
  },
);

app.get('/:id', requirePermission('weldobjects:read', 'weldobjects:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  try {
    const [row] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Custom object', id);
    const counts = await getCustomObjectCounts(db, [row.entityKey]);
    return success(c, {
      ...row,
      recordCount: counts[row.entityKey]?.recordCount ?? 0,
      fieldCount: counts[row.entityKey]?.fieldCount ?? 0,
    });
  } catch (err) {
    console.error('[app-api/custom-objects] get failed:', err);
    return error.internal(c, 'Failed to fetch custom object');
  }
});

/** What deleting this object would destroy — drives the confirmation dialog. */
app.get('/:id/delete-impact', requirePermission('weldobjects:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  try {
    const [row] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Custom object', id);
    // `blockedBy` lets the confirmation dialog say up front that the delete is
    // blocked, instead of letting the user type the confirmation and then
    // handing them a 409.
    const [impact, blockedBy] = await Promise.all([
      getDeleteImpact(db, row),
      findRestrictingLinks(db, row.entityKey),
    ]);
    return success(c, { ...impact, blockedBy });
  } catch (err) {
    console.error('[app-api/custom-objects] delete-impact failed:', err);
    return error.internal(c, 'Failed to compute delete impact');
  }
});

app.put(
  '/reorder',
  requirePermission('weldobjects:manage'),
  zValidator('json', reorderCustomObjectsSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const { items } = c.req.valid('json');

    try {
      // One unit of work. Statement-per-item would leave a partial ordering
      // behind on a mid-loop failure, and the sidebar would then render an
      // order the admin never asked for with no indication anything went wrong.
      const now = new Date();
      await atomically(db, (handle) =>
        items.map((item) =>
          handle
            .update(t)
            .set({ sortOrder: item.sortOrder, updatedAt: now })
            .where(and(eq(t.id, item.id), isNull(t.deletedAt))),
        ),
      );
      return success(c, { reordered: items.length });
    } catch (err) {
      console.error('[app-api/custom-objects] reorder failed:', err);
      return error.internal(c, 'Failed to reorder custom objects');
    }
  },
);

app.post(
  '/',
  requirePermission('weldobjects:manage'),
  zValidator('json', createCustomObjectSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const data = c.req.valid('json');
    const userId = c.get('userId');
    const entityKey = entityKeyForSlug(data.slug);

    try {
      // Check the SLUG rather than only the entity key: a soft-deleted object
      // still owns its slug, because its custom_field_values rows are keyed on
      // the derived entity key and reusing the slug would silently adopt them.
      const [existing] = await db
        .select({ id: t.id, deletedAt: t.deletedAt })
        .from(t)
        .where(eq(t.slug, data.slug))
        .limit(1);

      if (existing) {
        return error.conflict(
          c,
          existing.deletedAt
            ? `The name '${data.slug}' belonged to a deleted object and cannot be reused`
            : `A custom object with the name '${data.slug}' already exists`,
        );
      }

      const id = generateId('cobj');
      const now = new Date();

      await db.insert(t).values({
        id,
        slug: data.slug,
        entityKey,
        labelSingular: data.labelSingular,
        labelPlural: data.labelPlural,
        description: data.description,
        icon: data.icon ?? 'Box',
        color: data.color,
        status: data.status ?? 'draft',
        enableEvents: data.enableEvents ?? true,
        enableSearch: data.enableSearch ?? false,
        enableAgentTools: data.enableAgentTools ?? false,
        enableExternalApi: data.enableExternalApi ?? false,
        listConfig: data.listConfig ?? {},
        sortOrder: data.sortOrder ?? 0,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });

      const [created] = await db.select().from(t).where(eq(t.id, id)).limit(1);
      if (!created) return error.internal(c, 'Failed to create custom object');

      // The DEFINITION event uses the static `custom_field` catalog family
      // rather than the dynamic co_* key: this is metadata about an object,
      // not a record of one, so it belongs to the platform's own event space.
      publishEntityEvent({
        c,
        entityType: 'custom_field',
        entityId: id,
        action: 'created',
        data: { id, kind: 'custom_object', ...data },
      });

      return success(c, created, 201);
    } catch (err) {
      // The pre-check above is advisory: two concurrent creates can both pass
      // it and race to the insert, where the unique index on `slug` rejects the
      // loser. That's a caller conflict, not a server fault, so map it onto the
      // same 409 the pre-check returns instead of a 500.
      if (isUniqueViolation(err)) {
        return error.conflict(
          c,
          `A custom object with the name '${data.slug}' already exists`,
        );
      }
      console.error('[app-api/custom-objects] create failed:', err);
      return error.internal(c, 'Failed to create custom object');
    }
  },
);

app.put(
  '/:id',
  requirePermission('weldobjects:manage'),
  zValidator('json', updateCustomObjectSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');

    try {
      const [existing] = await db
        .select()
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Custom object', id);

      // titleFieldId must name a field that actually belongs to this object,
      // or every record silently loses its display name.
      if (data.titleFieldId) {
        const [def] = await db
          .select({ id: schema.customFieldDefinitions.id })
          .from(schema.customFieldDefinitions)
          .where(
            and(
              eq(schema.customFieldDefinitions.id, data.titleFieldId),
              eq(schema.customFieldDefinitions.entityType, existing.entityKey),
              isNull(schema.customFieldDefinitions.deletedAt),
            ),
          )
          .limit(1);
        if (!def) {
          return error.badRequest(
            c,
            'titleFieldId must reference a field belonging to this object',
          );
        }
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      for (const key of [
        'labelSingular', 'labelPlural', 'description', 'icon', 'color', 'status',
        'titleFieldId', 'enableEvents', 'enableSearch', 'enableAgentTools',
        'enableExternalApi', 'listConfig', 'sortOrder',
      ] as const) {
        if (data[key] !== undefined) patch[key] = data[key];
      }

      // Clear the index BEFORE the row update. The indexer gate only stops new
      // writes, so stale vectors have to be removed explicitly — and if this
      // ran after the update and threw, `enableSearch` would already be false,
      // making the retry a no-op (`existing.enableSearch` is now false) and
      // stranding the vectors permanently. Clearing first is idempotent: a
      // failure here leaves the flag on, so the caller can simply retry.
      if (existing.enableSearch && data.enableSearch === false) {
        await clearCustomObjectIndex(db, existing.entityKey);
      }

      await db.update(t).set(patch).where(eq(t.id, id));

      const [updated] = await db.select().from(t).where(eq(t.id, id)).limit(1);

      publishEntityEvent({
        c,
        entityType: 'custom_field',
        entityId: id,
        action: 'updated',
        data: { id, kind: 'custom_object', ...data },
      });

      return success(c, updated);
    } catch (err) {
      console.error('[app-api/custom-objects] update failed:', err);
      return error.internal(c, 'Failed to update custom object');
    }
  },
);

/**
 * Delete an object type and cascade.
 *
 * Requires `?confirm=<slug>` in the query string. This endpoint destroys every
 * record of the object along with its fields and relationships, and a
 * mis-routed DELETE should not be able to do that — the caller has to name what
 * they are deleting.
 */
app.delete('/:id', requirePermission('weldobjects:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const confirm = c.req.query('confirm');

  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Custom object', id);

    if (confirm !== existing.slug) {
      const impact = await getDeleteImpact(db, existing);
      return error.badRequest(
        c,
        `Deleting '${existing.labelPlural}' will remove ${impact.recordCount} record(s), ` +
          `${impact.fieldCount} field(s) and ${impact.relationCount} relationship(s). ` +
          `Re-send with ?confirm=${existing.slug} to proceed.`,
        impact,
      );
    }

    // `restrict` links pointing at this object block the delete, exactly as
    // they do for a single record. Without this the cascade wiped their edges
    // regardless, so the broader operation had the weaker guarantee.
    const restricting = await findRestrictingLinks(db, existing.entityKey);
    if (restricting.length > 0) {
      return error.conflict(
        c,
        `'${existing.labelPlural}' is still linked from ${restricting.join(', ')}, and those relationships are set to block deletion. ` +
          `Remove those links or change their delete rule first.`,
        { blockedBy: restricting },
      );
    }

    await deleteCustomObjectCascade(db, existing, atomically);

    publishEntityEvent({
      c,
      entityType: 'custom_field',
      entityId: id,
      action: 'deleted',
      data: { id, kind: 'custom_object', slug: existing.slug },
    });

    // 204, matching the record and relationship deletes. Not flagged in review,
    // but three deletes in one feature returning two different shapes is worse
    // than either shape on its own.
    return noContent(c);
  } catch (err) {
    console.error('[app-api/custom-objects] delete failed:', err);
    return error.internal(c, 'Failed to delete custom object');
  }
});

export const customObjectsRoutes = app;
