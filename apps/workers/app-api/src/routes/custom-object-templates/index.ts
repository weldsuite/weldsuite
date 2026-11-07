/**
 * WeldObjects — ready-made object types, mounted under `/api/custom-objects`
 * ahead of the `/:id` routes:
 *
 *   GET  /templates        what can be installed, and whether it already is
 *   POST /templates/:key   install one: the object, its fields and its links
 *
 * Installing is creating an object type, so it needs the same
 * `weldobjects:manage` as `POST /api/custom-objects`; it does not also need
 * the `settings:manage` the custom-fields routes ask for, because the fields
 * come with the object. A template whose slug is already taken answers 409,
 * with the live object in `details` when there is one.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import { entityKeyForSlug } from '@weldsuite/core-domain/custom-objects';
import type { Env, Variables } from '../../types';
import {
  CUSTOM_OBJECT_TEMPLATES,
  findCustomObjectTemplate,
} from '../../services/custom-object-templates';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const objects = schema.customObjects;

app.get('/templates', requirePermission('weldobjects:read', 'weldobjects:manage'), async (c) => {
  const db = c.get('tenantDb');

  try {
    const rows = await db
      .select({ id: objects.id, slug: objects.slug, deletedAt: objects.deletedAt })
      .from(objects);
    const live = new Map(rows.filter((r) => !r.deletedAt).map((r) => [r.slug, r.id]));
    const data = CUSTOM_OBJECT_TEMPLATES.map((template) => ({
      key: template.key,
      slug: template.slug,
      labelSingular: template.labelSingular,
      labelPlural: template.labelPlural,
      description: template.description,
      icon: template.icon,
      fieldCount: template.fields.length,
      linkCount: template.links.length,
      installed: live.has(template.slug),
      objectId: live.get(template.slug) ?? null,
    }));
    return list(c, data, cursorPagination(data.length, false, null));
  } catch (err) {
    console.error('[app-api/custom-objects] list templates failed:', err);
    return error.internal(c, 'Failed to list object templates');
  }
});

app.post('/templates/:key', requirePermission('weldobjects:manage'), async (c) => {
  const db = c.get('tenantDb');
  const key = c.req.param('key');
  const userId = c.get('userId');
  const template = findCustomObjectTemplate(key);
  if (!template) return error.notFound(c, 'Object template', key);
  const taken = `A custom object with the name '${template.slug}' already exists`;

  try {
    const [existing] = await db.select().from(objects).where(eq(objects.slug, template.slug)).limit(1);
    if (existing?.deletedAt) {
      return error.conflict(
        c,
        `The name '${template.slug}' belonged to a deleted object and cannot be reused`,
      );
    }
    if (existing) return error.conflict(c, taken, existing);

    const entityKey = entityKeyForSlug(template.slug);
    const objectId = generateId('cobj');
    const fields = template.fields.map((field, index) => ({ ...field, id: generateId('cfld'), sortOrder: index }));
    const links = template.links.map((link) => ({ ...link, id: generateId('colk') }));
    const titleFieldId = fields.find((field) => field.slug === template.titleField)?.id ?? null;
    const now = new Date();

    await atomically(db, (handle) => [
      handle.insert(objects).values({
        id: objectId,
        slug: template.slug,
        entityKey,
        labelSingular: template.labelSingular,
        labelPlural: template.labelPlural,
        description: template.description,
        icon: template.icon,
        titleFieldId,
        status: 'active',
        enableEvents: template.enableEvents,
        enableSearch: template.enableSearch,
        enableAgentTools: false,
        enableExternalApi: false,
        listConfig: {},
        sortOrder: 0,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      }),
      handle.insert(schema.customFieldDefinitions).values(
        fields.map((field) => ({
          id: field.id,
          entityType: entityKey,
          name: field.name,
          slug: field.slug,
          fieldType: field.fieldType,
          options: field.options ?? null,
          required: field.required,
          sortOrder: field.sortOrder,
          createdAt: now,
          updatedAt: now,
        })),
      ),
      handle.insert(schema.customObjectLinks).values(
        links.map((link, index) => ({
          id: link.id,
          slug: link.slug,
          sourceEntityKey: entityKey,
          targetEntityKey: link.targetEntityKey,
          cardinality: link.cardinality,
          sourceLabel: link.sourceLabel,
          targetLabel: link.targetLabel,
          onDelete: link.onDelete,
          required: false,
          sortOrder: index,
          createdAt: now,
          updatedAt: now,
        })),
      ),
    ]);

    const [created] = await db.select().from(objects).where(eq(objects.id, objectId)).limit(1);
    if (!created) return error.internal(c, 'Failed to install object template');

    // The same events the object, field and relationship routes publish, so
    // an install reads in the audit log like the definitions made by hand.
    publishEntityEvent({
      c,
      entityType: 'custom_field',
      entityId: objectId,
      action: 'created',
      data: {
        id: objectId,
        kind: 'custom_object',
        template: template.key,
        slug: template.slug,
        labelSingular: template.labelSingular,
        labelPlural: template.labelPlural,
        description: template.description,
        icon: template.icon,
        status: 'active',
        enableEvents: template.enableEvents,
        enableSearch: template.enableSearch,
      },
    });
    for (const field of fields) {
      publishEntityEvent({
        c,
        entityType: 'custom_field',
        entityId: field.id,
        action: 'created',
        data: {
          id: field.id,
          entityType: entityKey,
          name: field.name,
          slug: field.slug,
          fieldType: field.fieldType,
          ...(field.options ? { options: field.options } : {}),
          required: field.required,
          sortOrder: field.sortOrder,
        },
      });
    }
    for (const link of links) {
      publishEntityEvent({
        c,
        entityType: 'custom_field',
        entityId: link.id,
        action: 'created',
        data: {
          id: link.id,
          kind: 'custom_object_link',
          objectId,
          slug: link.slug,
          targetEntityKey: link.targetEntityKey,
          cardinality: link.cardinality,
          sourceLabel: link.sourceLabel,
          targetLabel: link.targetLabel,
          onDelete: link.onDelete,
        },
      });
    }

    return success(c, created, 201);
  } catch (err) {
    // Two installs racing past the check: the unique index on `slug` decides.
    if (isUniqueViolation(err)) return error.conflict(c, taken);
    console.error('[app-api/custom-objects] install template failed:', err);
    return error.internal(c, 'Failed to install object template');
  }
});

export const customObjectTemplateRoutes = app;
