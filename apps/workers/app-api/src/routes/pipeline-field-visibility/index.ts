/**
 * Pipeline field-visibility routes — /api/pipeline-field-visibility/:id/field-visibility
 *
 * Reads and updates the `crmPipelines.settings.fieldVisibility` JSONB
 * sub-object. Other pipeline settings keys (probability display, etc.) are
 * preserved verbatim on write. The canonical pipeline CRUD lives at
 * /api/pipelines.
 *
 * Permissions: pipelines:read (GET) | pipelines:update (PATCH).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { updatePipelineFieldVisibilitySchema } from '@weldsuite/app-api-client/schemas/pipeline-field-visibility';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.crmPipelines;

interface PipelineSettings {
  fieldVisibility?: Record<string, unknown>;
  [key: string]: unknown;
}

app.get('/:id/field-visibility', requirePermission('pipelines:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select({ settings: t.settings })
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Pipeline', id);
    const settings = (row.settings as PipelineSettings | null) ?? {};
    return success(c, settings.fieldVisibility ?? {});
  } catch (err) {
    console.error('[app-api/pipeline-field-visibility] get failed:', err);
    return error.internal(c, 'Failed to read pipeline field visibility');
  }
});

app.patch(
  '/:id/field-visibility',
  requirePermission('pipelines:update'),
  zValidator('json', updatePipelineFieldVisibilitySchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const input = c.req.valid('json');
    try {
      const [row] = await db
        .select({ settings: t.settings })
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!row) return error.notFound(c, 'Pipeline', id);
      const existing = (row.settings as PipelineSettings | null) ?? {};
      const next: PipelineSettings = {
        ...existing,
        fieldVisibility: {
          ...(existing.fieldVisibility ?? {}),
          ...input,
        },
      };
      await db
        .update(t)
        .set({ settings: next, updatedAt: new Date() })
        .where(and(eq(t.id, id), isNull(t.deletedAt)));
      publishEntityEvent({
        c,
        entityType: 'pipeline',
        entityId: id,
        action: 'updated',
        data: { id },
      });
      return success(c, next.fieldVisibility ?? {});
    } catch (err) {
      console.error('[app-api/pipeline-field-visibility] update failed:', err);
      return error.internal(c, 'Failed to update pipeline field visibility');
    }
  },
);

export const pipelineFieldVisibilityRoutes = app;
