/**
 * WeldObjects — third-party API surface (`/v1/custom-objects/*`).
 *
 * Only objects with `enableExternalApi` are reachable here. That switch is the
 * whole point of the endpoint: a workspace decides which of its user-defined
 * objects are part of its public integration contract, and an object that
 * hasn't opted in 404s exactly as if it didn't exist.
 *
 * Scopes:
 *   custom-objects:read   list/describe objects, read records
 *   custom-objects:write  create/update/delete records
 *
 * Object TYPES are not editable here. Defining an object changes the tenant's
 * schema and is a platform-admin action — `weldobjects:manage` in app-api — not
 * something an integration key should be able to do.
 *
 * Record CRUD goes through the same `@weldsuite/db/lib/custom-objects` helpers
 * app-api uses, so validation, title maintenance and cascade behaviour cannot
 * drift between the two surfaces.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { publishCustomObjectEvent } from '@weldsuite/entity-events';
import {
  createRecord,
  deleteRecord,
  getCustomObjectBySlug,
  getRecord,
  listAgentToolObjects,
  listCustomObjects,
  listRecordsSimple,
  parseLimit,
  updateRecord,
  type CustomObjectRow,
} from '@weldsuite/db/lib/custom-objects';
import { CustomFieldValidationError } from '@weldsuite/db/lib/custom-field-values';
import {
  createCustomObjectRecordSchema,
  updateCustomObjectRecordSchema,
} from '@weldsuite/app-api-client/schemas/custom-objects';
import type { HonoEnv } from '../../types';
import { requireScope } from '../../lib/scopes';
import { generateId } from '../../lib/id';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';

const app = new Hono<HonoEnv>();

/**
 * Resolve `:slug` to an object that is actually exposed externally.
 *
 * Returns null for an unknown slug, a disabled object, OR one that hasn't
 * opted into the external API — all three surface as 404. Distinguishing them
 * would tell an integration which objects exist but are private, which is
 * information the key holder has no claim to.
 */
async function resolveExposedObject(
  db: HonoEnv['Variables']['tenantDb'],
  slug: string,
): Promise<CustomObjectRow | null> {
  const object = await getCustomObjectBySlug(db, slug);
  if (!object) return null;
  if (!object.enableExternalApi) return null;
  if (object.status !== 'active') return null;
  return object;
}

/** Public shape — never leaks the internal id or the integration switches. */
function toPublicObject(object: CustomObjectRow) {
  return {
    slug: object.slug,
    labelSingular: object.labelSingular,
    labelPlural: object.labelPlural,
    description: object.description,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

app.get('/', requireScope('custom-objects:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const objects = await listCustomObjects(db, { status: 'active', externalApiOnly: true });
    return success(c, objects.map(toPublicObject));
  } catch (err) {
    console.error('[mcp-server/custom-objects] list failed:', err);
    return error.internal(c, 'Failed to list custom objects');
  }
});

/**
 * Dynamic agent tools for WeldAgent and the MCP server.
 *
 * Mirrors `GET /v1/user-apps/agent-tools`: the caller's key identifies the
 * workspace, and the response is everything the MCP server needs to synthesise
 * one tool set per object without knowing anything about custom objects itself.
 */
app.get('/agent-tools', requireScope('custom-objects:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    return success(c, await listAgentToolObjects(db));
  } catch (err) {
    console.error('[mcp-server/custom-objects] agent-tools failed:', err);
    return error.internal(c, 'Failed to list custom object agent tools');
  }
});

app.get('/:slug', requireScope('custom-objects:read'), async (c) => {
  const db = c.get('tenantDb');
  const slug = c.req.param('slug');
  try {
    const object = await resolveExposedObject(db, slug);
    if (!object) return error.notFound(c, 'Custom object', slug);
    return success(c, toPublicObject(object));
  } catch (err) {
    console.error('[mcp-server/custom-objects] get failed:', err);
    return error.internal(c, 'Failed to fetch custom object');
  }
});

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

app.get('/:slug/records', requireScope('custom-objects:read'), async (c) => {
  const db = c.get('tenantDb');
  const slug = c.req.param('slug');
  const q = c.req.query();

  try {
    const object = await resolveExposedObject(db, slug);
    if (!object) return error.notFound(c, 'Custom object', slug);

    const result = await listRecordsSimple(db, object, {
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      search: q.search,
      ownerId: q.ownerId,
    });

    return list(
      c,
      result.data,
      cursorPagination(result.totalCount, result.hasMore, result.cursor),
    );
  } catch (err) {
    console.error('[mcp-server/custom-objects] list records failed:', err);
    return error.internal(c, 'Failed to list records');
  }
});

app.get('/:slug/records/:id', requireScope('custom-objects:read'), async (c) => {
  const db = c.get('tenantDb');
  const slug = c.req.param('slug');
  const id = c.req.param('id');

  try {
    const object = await resolveExposedObject(db, slug);
    if (!object) return error.notFound(c, 'Custom object', slug);

    const record = await getRecord(db, object, id);
    if (!record) return error.notFound(c, object.labelSingular, id);
    return success(c, record);
  } catch (err) {
    console.error('[mcp-server/custom-objects] get record failed:', err);
    return error.internal(c, 'Failed to fetch record');
  }
});

app.post(
  '/:slug/records',
  requireScope('custom-objects:write'),
  zValidator('json', createCustomObjectRecordSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const slug = c.req.param('slug');
    const data = c.req.valid('json');
    const userId = c.get('userId');

    try {
      const object = await resolveExposedObject(db, slug);
      if (!object) return error.notFound(c, 'Custom object', slug);

      const record = await createRecord(db, object, data, userId, generateId);

      if (object.enableEvents) {
        publishCustomObjectEvent({
          c,
          entityKey: object.entityKey,
          action: 'created',
          entityId: record.id,
          data: { ...record },
        });
      }

      return success(c, record, 201);
    } catch (err) {
      if (err instanceof CustomFieldValidationError) return error.badRequest(c, err.message);
      console.error('[mcp-server/custom-objects] create record failed:', err);
      return error.internal(c, 'Failed to create record');
    }
  },
);

app.patch(
  '/:slug/records/:id',
  requireScope('custom-objects:write'),
  zValidator('json', updateCustomObjectRecordSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const slug = c.req.param('slug');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    const userId = c.get('userId');

    try {
      const object = await resolveExposedObject(db, slug);
      if (!object) return error.notFound(c, 'Custom object', slug);

      const existing = await getRecord(db, object, id);
      if (!existing) return error.notFound(c, object.labelSingular, id);

      const updated = await updateRecord(db, object, existing, data, userId, generateId);

      if (object.enableEvents) {
        publishCustomObjectEvent({
          c,
          entityKey: object.entityKey,
          action: 'updated',
          entityId: id,
          data: { ...updated },
        });
      }

      return success(c, updated);
    } catch (err) {
      if (err instanceof CustomFieldValidationError) return error.badRequest(c, err.message);
      console.error('[mcp-server/custom-objects] update record failed:', err);
      return error.internal(c, 'Failed to update record');
    }
  },
);

app.delete('/:slug/records/:id', requireScope('custom-objects:write'), async (c) => {
  const db = c.get('tenantDb');
  const slug = c.req.param('slug');
  const id = c.req.param('id');

  try {
    const object = await resolveExposedObject(db, slug);
    if (!object) return error.notFound(c, 'Custom object', slug);

    const existing = await getRecord(db, object, id);
    if (!existing) return error.notFound(c, object.labelSingular, id);

    await deleteRecord(db, object, id);

    if (object.enableEvents) {
      publishCustomObjectEvent({
        c,
        entityKey: object.entityKey,
        action: 'deleted',
        entityId: id,
        data: { id, title: existing.title },
      });
    }

    return noContent(c);
  } catch (err) {
    console.error('[mcp-server/custom-objects] delete record failed:', err);
    return error.internal(c, 'Failed to delete record');
  }
});

export default app;
