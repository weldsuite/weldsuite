/**
 * WeldObjects — relationship routes.
 *
 * Three surfaces with three different permission models, which is why they are
 * one file rather than three:
 *
 *   /api/custom-objects/:id/links       define relationships   weldobjects:manage
 *   /api/objects/:slug/records/:id/links traverse + attach     weldobjects:<slug>:read|update
 *   /api/related/:entityType/:entityId  reverse lookup         weldobjects:read
 *
 * The reverse lookup is the one that makes custom objects feel native: it lets
 * a Customer detail page render a "Machines" panel without WeldCRM knowing
 * custom objects exist.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent, publishCustomObjectEvent } from '@weldsuite/entity-events';
import {
  createCustomObjectLinkSchema,
  updateCustomObjectLinkSchema,
} from '@weldsuite/app-api-client/schemas/custom-objects';
import type { Env, Variables } from '../../types';
import type { Database } from '../../db';
import { atomically } from '../../lib/atomically';
import { error, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import {
  requireCustomObject,
  customObjectScope,
  getCustomObject,
  canReadTarget,
} from '../../middleware/custom-object';
import {
  getRecord,
  entityKeyForSlug,
  type CustomObjectRow,
} from '../../services/custom-objects';
import {
  assertValidTarget,
  attach,
  detach,
  getLinkBySlug,
  LinkCardinalityError,
  LinkTargetError,
  listLinksForObject,
  listRelated,
  listReversePanels,
} from '../../services/custom-object-links';
import { listLinkableBuiltins } from '../../services/custom-object-targets';

const links = schema.customObjectLinks;

/**
 * Publish `co_<slug>:updated` for a source record whose relationships changed.
 *
 * Honours the object's `enableEvents` switch, same as the record routes. The
 * payload carries which link changed and in which direction so a workflow can
 * condition on it without re-fetching the edge table.
 */
function emitSourceUpdated(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  object: CustomObjectRow,
  recordId: string,
  detail: Record<string, unknown>,
): void {
  if (!object.enableEvents) return;
  publishCustomObjectEvent({
    c,
    entityKey: object.entityKey,
    action: 'updated',
    entityId: recordId,
    data: { id: recordId, relationship: detail },
  });
}

/** Resolve `:id` to a live custom object row. */
async function resolveObject(db: Database, objectId: string) {
  const [row] = await db
    .select()
    .from(schema.customObjects)
    .where(and(eq(schema.customObjects.id, objectId), isNull(schema.customObjects.deletedAt)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Definition surface — mounted under /api/custom-objects
// ---------------------------------------------------------------------------

const definitionApp = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Entities a link may point at — populates the link editor's target picker. */
definitionApp.get('/link-targets', requirePermission('weldobjects:manage'), async (c) => {
  const db = c.get('tenantDb');

  try {
    const builtins = listLinkableBuiltins().map((b) => ({ ...b, kind: 'builtin' as const }));
    const customObjects = await db
      .select({
        entityType: schema.customObjects.entityKey,
        label: schema.customObjects.labelPlural,
      })
      .from(schema.customObjects)
      .where(isNull(schema.customObjects.deletedAt));

    return success(c, [
      ...builtins,
      ...customObjects.map((o) => ({ ...o, kind: 'custom' as const })),
    ]);
  } catch (err) {
    console.error('[app-api/custom-objects] link-targets failed:', err);
    return error.internal(c, 'Failed to list link targets');
  }
});

definitionApp.get('/:id/links', requirePermission('weldobjects:read', 'weldobjects:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  try {
    const [object] = await db
      .select()
      .from(schema.customObjects)
      .where(and(eq(schema.customObjects.id, id), isNull(schema.customObjects.deletedAt)))
      .limit(1);
    if (!object) return error.notFound(c, 'Custom object', id);

    return success(c, await listLinksForObject(db, object.entityKey));
  } catch (err) {
    console.error('[app-api/custom-objects] list links failed:', err);
    return error.internal(c, 'Failed to list relationships');
  }
});

definitionApp.post(
  '/:id/links',
  requirePermission('weldobjects:manage'),
  zValidator('json', createCustomObjectLinkSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');

    try {
      const [object] = await db
        .select()
        .from(schema.customObjects)
        .where(and(eq(schema.customObjects.id, id), isNull(schema.customObjects.deletedAt)))
        .limit(1);
      if (!object) return error.notFound(c, 'Custom object', id);

      // Second gate after the Zod allow-list: confirms a co_* target is a live
      // object rather than a plausible-looking string.
      await assertValidTarget(db, data.targetEntityKey);

      const existing = await getLinkBySlug(db, object.entityKey, data.slug);
      if (existing) {
        return error.conflict(c, `A relationship named '${data.slug}' already exists on this object`);
      }

      const linkId = generateId('colk');
      const now = new Date();

      await db.insert(links).values({
        id: linkId,
        slug: data.slug,
        sourceEntityKey: object.entityKey,
        targetEntityKey: data.targetEntityKey,
        cardinality: data.cardinality,
        sourceLabel: data.sourceLabel,
        targetLabel: data.targetLabel,
        onDelete: data.onDelete ?? 'set_null',
        required: data.required ?? false,
        sortOrder: data.sortOrder ?? 0,
        createdAt: now,
        updatedAt: now,
      });

      const [created] = await db.select().from(links).where(eq(links.id, linkId)).limit(1);

      // A relationship definition is object metadata, so it rides the same
      // `custom_field` event family as the object routes rather than the
      // dynamic co_* key — this describes the schema, not a record in it.
      publishEntityEvent({
        c,
        entityType: 'custom_field',
        entityId: linkId,
        action: 'created',
        data: { id: linkId, kind: 'custom_object_link', objectId: object.id, ...data },
      });

      return success(c, created, 201);
    } catch (err) {
      if (err instanceof LinkTargetError) return error.badRequest(c, err.message);
      console.error('[app-api/custom-objects] create link failed:', err);
      return error.internal(c, 'Failed to create relationship');
    }
  },
);

definitionApp.put(
  '/:id/links/:linkId',
  requirePermission('weldobjects:manage'),
  zValidator('json', updateCustomObjectLinkSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const objectId = c.req.param('id');
    const linkId = c.req.param('linkId');
    const data = c.req.valid('json');

    try {
      // Resolve `:id` and scope the lookup to it. Looking the link up by
      // `linkId` alone made the object segment decorative: a client bug could
      // edit a relationship belonging to a different object and get a 200.
      // `weldobjects:manage` is workspace-wide so this isn't an escalation,
      // but the route contract should mean what it says.
      const object = await resolveObject(db, objectId);
      if (!object) return error.notFound(c, 'Custom object', objectId);

      const [existing] = await db
        .select()
        .from(links)
        .where(
          and(
            eq(links.id, linkId),
            eq(links.sourceEntityKey, object.entityKey),
            isNull(links.deletedAt),
          ),
        )
        .limit(1);
      if (!existing) return error.notFound(c, 'Relationship', linkId);

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      for (const key of ['sourceLabel', 'targetLabel', 'onDelete', 'required', 'sortOrder'] as const) {
        if (data[key] !== undefined) patch[key] = data[key];
      }

      await db.update(links).set(patch).where(eq(links.id, linkId));
      const [updated] = await db.select().from(links).where(eq(links.id, linkId)).limit(1);

      publishEntityEvent({
        c,
        entityType: 'custom_field',
        entityId: linkId,
        action: 'updated',
        data: { id: linkId, kind: 'custom_object_link', ...data },
      });

      return success(c, updated);
    } catch (err) {
      console.error('[app-api/custom-objects] update link failed:', err);
      return error.internal(c, 'Failed to update relationship');
    }
  },
);

/** Soft-deletes the definition and hard-deletes its edges — an edge whose link
 *  is gone has no meaning and would surface as a ghost in reverse panels. */
definitionApp.delete('/:id/links/:linkId', requirePermission('weldobjects:manage'), async (c) => {
  const db = c.get('tenantDb');
  const objectId = c.req.param('id');
  const linkId = c.req.param('linkId');

  try {
    const object = await resolveObject(db, objectId);
    if (!object) return error.notFound(c, 'Custom object', objectId);

    const [existing] = await db
      .select()
      .from(links)
      .where(
        and(
          eq(links.id, linkId),
          eq(links.sourceEntityKey, object.entityKey),
          isNull(links.deletedAt),
        ),
      )
      .limit(1);
    if (!existing) return error.notFound(c, 'Relationship', linkId);

    // Edges and definition go together: an edge whose link is soft-deleted has
    // no meaning and would surface as a ghost row in reverse panels.
    const now = new Date();
    await atomically(db, (handle) => [
      handle
        .delete(schema.customObjectRelations)
        .where(eq(schema.customObjectRelations.linkId, linkId)),
      handle.update(links).set({ deletedAt: now, updatedAt: now }).where(eq(links.id, linkId)),
    ]);

    publishEntityEvent({
      c,
      entityType: 'custom_field',
      entityId: linkId,
      action: 'deleted',
      data: { id: linkId, kind: 'custom_object_link', slug: existing.slug },
    });

    return noContent(c);
  } catch (err) {
    console.error('[app-api/custom-objects] delete link failed:', err);
    return error.internal(c, 'Failed to delete relationship');
  }
});

// ---------------------------------------------------------------------------
// Traversal surface — mounted under /api/objects
// ---------------------------------------------------------------------------

const traversalApp = new Hono<{ Bindings: Env; Variables: Variables }>();

traversalApp.get('/:slug/records/:id/links', requireCustomObject('read'), async (c) => {
  const db = c.get('tenantDb');
  const object = getCustomObject(c);
  const recordId = c.req.param('id');
  const scope = await customObjectScope(c);

  try {
    const record = await getRecord(db, object, recordId, scope);
    if (!record) return error.notFound(c, object.labelSingular, recordId);

    // Drop whole panels the caller can't read the target type of, rather than
    // resolving titles they have no permission to see. One permission check per
    // LINK, not per record — permissions are resolved once and cached on the
    // context, so this costs nothing beyond the first call.
    const allLinks = await listLinksForObject(db, object.entityKey);
    const readable = [];
    for (const link of allLinks) {
      if (await canReadTarget(c, link.targetEntityKey)) readable.push(link);
    }

    const panels = await Promise.all(
      readable.map(async (link) => ({
        linkId: link.id,
        linkSlug: link.slug,
        label: link.targetLabel,
        cardinality: link.cardinality,
        targetEntityKey: link.targetEntityKey,
        records: await listRelated(db, link, recordId),
      })),
    );

    return success(c, panels);
  } catch (err) {
    console.error(`[app-api/objects/${object.slug}] list links failed:`, err);
    return error.internal(c, 'Failed to load related records');
  }
});

traversalApp.get(
  '/:slug/records/:id/links/:linkSlug',
  requireCustomObject('read'),
  async (c) => {
    const db = c.get('tenantDb');
    const object = getCustomObject(c);
    const recordId = c.req.param('id');
    const linkSlug = c.req.param('linkSlug');
    const scope = await customObjectScope(c);

    try {
      const record = await getRecord(db, object, recordId, scope);
      if (!record) return error.notFound(c, object.labelSingular, recordId);

      const link = await getLinkBySlug(db, object.entityKey, linkSlug);
      if (!link) return error.notFound(c, 'Relationship', linkSlug);

      if (!(await canReadTarget(c, link.targetEntityKey))) {
        return error.forbidden(
          c,
          `You do not have permission to view ${link.targetLabel.toLowerCase()}`,
        );
      }

      return success(c, await listRelated(db, link, recordId));
    } catch (err) {
      console.error(`[app-api/objects/${object.slug}] related failed:`, err);
      return error.internal(c, 'Failed to load related records');
    }
  },
);

/** Attaching is a write to the SOURCE record, so it needs `:update`. */
traversalApp.post(
  '/:slug/records/:id/links/:linkSlug/:targetId',
  requireCustomObject('update'),
  async (c) => {
    const db = c.get('tenantDb');
    const object = getCustomObject(c);
    const recordId = c.req.param('id');
    const linkSlug = c.req.param('linkSlug');
    const targetId = c.req.param('targetId');
    const userId = c.get('userId');
    const scope = await customObjectScope(c);

    try {
      const record = await getRecord(db, object, recordId, scope);
      if (!record) return error.notFound(c, object.labelSingular, recordId);

      const link = await getLinkBySlug(db, object.entityKey, linkSlug);
      if (!link) return error.notFound(c, 'Relationship', linkSlug);

      // Attaching exposes the target's title through the related panel, so it
      // needs read access to the TARGET, not just update on the source.
      if (!(await canReadTarget(c, link.targetEntityKey))) {
        return error.forbidden(
          c,
          `You do not have permission to link ${link.targetLabel.toLowerCase()}`,
        );
      }

      await attach(db, link, recordId, targetId, userId);

      // An edge change IS a change to the source record as far as any consumer
      // is concerned — workflows, webhooks and the search indexer all key off
      // the record, not the join table. Emitted as `updated` on the source's
      // own co_* type rather than a bespoke event, so existing subscribers pick
      // it up without knowing relationships exist.
      emitSourceUpdated(c, object, recordId, {
        link: link.slug,
        action: 'attached',
        targetEntityKey: link.targetEntityKey,
        targetId,
      });

      return success(c, await listRelated(db, link, recordId), 201);
    } catch (err) {
      if (err instanceof LinkCardinalityError) return error.conflict(c, err.message);
      console.error(`[app-api/objects/${object.slug}] attach failed:`, err);
      return error.internal(c, 'Failed to link records');
    }
  },
);

traversalApp.delete(
  '/:slug/records/:id/links/:linkSlug/:targetId',
  requireCustomObject('update'),
  async (c) => {
    const db = c.get('tenantDb');
    const object = getCustomObject(c);
    const recordId = c.req.param('id');
    const linkSlug = c.req.param('linkSlug');
    const targetId = c.req.param('targetId');
    const scope = await customObjectScope(c);

    try {
      const record = await getRecord(db, object, recordId, scope);
      if (!record) return error.notFound(c, object.labelSingular, recordId);

      const link = await getLinkBySlug(db, object.entityKey, linkSlug);
      if (!link) return error.notFound(c, 'Relationship', linkSlug);

      await detach(db, link, recordId, targetId);

      emitSourceUpdated(c, object, recordId, {
        link: link.slug,
        action: 'detached',
        targetEntityKey: link.targetEntityKey,
        targetId,
      });

      return noContent(c);
    } catch (err) {
      console.error(`[app-api/objects/${object.slug}] detach failed:`, err);
      return error.internal(c, 'Failed to unlink records');
    }
  },
);

// ---------------------------------------------------------------------------
// Reverse lookup — mounted at /api/related
// ---------------------------------------------------------------------------

const reverseApp = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Custom object records linked to an arbitrary record, grouped by relationship.
 *
 * Each panel is filtered by `weldobjects:<slug>:read` for the object the
 * records belong to. An earlier version checked only the module-level
 * `weldobjects:read`, on the reasoning that per-object checks would be too
 * expensive to render one detail page — that was wrong on both counts: the
 * panel exposes record TITLES, and permissions resolve once per request and are
 * cached on the context, so this is one set-membership test per panel.
 */
reverseApp.get('/:entityType/:entityId/custom-objects', requirePermission('weldobjects:read'), async (c) => {
  const db = c.get('tenantDb');
  const entityType = c.req.param('entityType');
  const entityId = c.req.param('entityId');

  try {
    const panels = await listReversePanels(db, entityType, entityId);

    const visible = [];
    for (const panel of panels) {
      if (await canReadTarget(c, entityKeyForSlug(panel.objectSlug))) visible.push(panel);
    }

    return success(c, visible);
  } catch (err) {
    console.error('[app-api/related] reverse lookup failed:', err);
    return error.internal(c, 'Failed to load related custom object records');
  }
});

export const customObjectLinkDefinitionRoutes = definitionApp;
export const customObjectLinkTraversalRoutes = traversalApp;
export const customObjectReverseRoutes = reverseApp;
