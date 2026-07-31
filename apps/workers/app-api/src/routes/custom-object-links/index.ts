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

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  createCustomObjectLinkSchema,
  updateCustomObjectLinkSchema,
} from '@weldsuite/app-api-client/schemas/custom-objects';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import {
  requireCustomObject,
  customObjectScope,
  getCustomObject,
} from '../../middleware/custom-object';
import { getRecord } from '../../services/custom-objects';
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
    const linkId = c.req.param('linkId');
    const data = c.req.valid('json');

    try {
      const [existing] = await db
        .select()
        .from(links)
        .where(and(eq(links.id, linkId), isNull(links.deletedAt)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Relationship', linkId);

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      for (const key of ['sourceLabel', 'targetLabel', 'onDelete', 'required', 'sortOrder'] as const) {
        if (data[key] !== undefined) patch[key] = data[key];
      }

      await db.update(links).set(patch).where(eq(links.id, linkId));
      const [updated] = await db.select().from(links).where(eq(links.id, linkId)).limit(1);
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
  const linkId = c.req.param('linkId');

  try {
    const [existing] = await db
      .select()
      .from(links)
      .where(and(eq(links.id, linkId), isNull(links.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Relationship', linkId);

    const now = new Date();
    await db.delete(schema.customObjectRelations).where(eq(schema.customObjectRelations.linkId, linkId));
    await db.update(links).set({ deletedAt: now, updatedAt: now }).where(eq(links.id, linkId));

    return success(c, { deleted: true });
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

    const linkRows = await listLinksForObject(db, object.entityKey);
    const panels = await Promise.all(
      linkRows.map(async (link) => ({
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

      await attach(db, link, recordId, targetId, userId);
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
 * Gated on `weldobjects:read` only. The per-object read grant is deliberately
 * NOT checked here: this returns titles of records already linked to something
 * the caller is looking at, and requiring N permission resolutions to render
 * one detail page would make the panel too expensive to be worth having. If an
 * object's records are sensitive enough that their titles matter, the object
 * should not be linked to a widely-visible entity in the first place.
 */
reverseApp.get('/:entityType/:entityId/custom-objects', requirePermission('weldobjects:read'), async (c) => {
  const db = c.get('tenantDb');
  const entityType = c.req.param('entityType');
  const entityId = c.req.param('entityId');

  try {
    return success(c, await listReversePanels(db, entityType, entityId));
  } catch (err) {
    console.error('[app-api/related] reverse lookup failed:', err);
    return error.internal(c, 'Failed to load related custom object records');
  }
});

export const customObjectLinkDefinitionRoutes = definitionApp;
export const customObjectLinkTraversalRoutes = traversalApp;
export const customObjectReverseRoutes = reverseApp;
