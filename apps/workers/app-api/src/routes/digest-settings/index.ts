/**
 * Task digest settings routes — /api/digest-settings/* singleton config backed
 * by the `taskDigestSettings` table (tenant DB). There is at most one row per
 * tenant, so this is a singleton: GET / + PUT / only (no resource /:id
 * lifecycle).
 *
 * PUT performs a dual write: the full settings live in the tenant DB, while
 * schedule metadata (enabled / sendHour / timezone) is synced into the master
 * DB `digestSchedules` table so the cron runner can fan out without a tenant
 * lookup. The PUT / mutation publishes a `digest_settings` entity event.
 *
 * Because there is no `/:id` mutation surface, this route is registered as
 * EXEMPT in _event-coverage.test.ts for the core-CRUD sweep.
 *
 * Permissions: settings:read (reads) | settings:manage (mutations).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { updateDigestSettingsSchema } from '@weldsuite/app-api-client/schemas/digest-settings';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema, getMasterDb, masterSchema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET / — Retrieve task digest settings (returns defaults when none set).
 */
app.get('/', requirePermission('settings:read'), async (c) => {
  try {
    const db = c.get('tenantDb');

    const [existing] = await db.select().from(schema.taskDigestSettings).limit(1);

    if (existing) return success(c, existing);

    return success(c, {
      id: null,
      enabled: true,
      sendHour: 8,
      taskTypes: { projectTasks: true, personalTasks: true },
      sections: { overdue: true, dueToday: true, dueThisWeek: true },
      createdAt: null,
      updatedAt: null,
    });
  } catch (err) {
    console.error('[app-api/digest-settings] get failed:', err);
    return error.internal(c, 'Failed to fetch digest settings');
  }
});

/**
 * PUT / — Upsert digest settings.
 *
 * Dual write:
 *   1. Upsert taskDigestSettings in the tenant DB (full settings)
 *   2. Upsert digestSchedules in the master DB (schedule metadata only)
 */
app.put('/', requirePermission('settings:manage'), zValidator('json', updateDigestSettingsSchema), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const body = c.req.valid('json');
  const db = c.get('tenantDb');

  try {
    // 1. Upsert in tenant DB
    const [existing] = await db.select().from(schema.taskDigestSettings).limit(1);

    let settings;
    if (existing) {
      [settings] = await db
        .update(schema.taskDigestSettings)
        .set({
          enabled: body.enabled,
          sendHour: body.sendHour,
          taskTypes: body.taskTypes,
          sections: body.sections,
          updatedAt: new Date(),
        })
        .where(eq(schema.taskDigestSettings.id, existing.id))
        .returning();
    } else {
      [settings] = await db
        .insert(schema.taskDigestSettings)
        .values({
          id: generateId('tds'),
          enabled: body.enabled,
          sendHour: body.sendHour,
          taskTypes: body.taskTypes,
          sections: body.sections,
        })
        .returning();
    }

    // 2. Read workspace timezone from tenant settings
    const [wsSettings] = await db
      .select({ timezone: schema.workspaceSettings.timezone })
      .from(schema.workspaceSettings)
      .limit(1);

    const timezone = wsSettings?.timezone || 'UTC';

    // 3. Sync schedule metadata to master DB
    const masterDb = getMasterDb(c.env);

    const [workspace] = await masterDb
      .select({ id: masterSchema.workspaces.id })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.clerkOrgId, orgId))
      .limit(1);

    if (workspace) {
      const [existingSchedule] = await masterDb
        .select()
        .from(masterSchema.digestSchedules)
        .where(eq(masterSchema.digestSchedules.workspaceId, workspace.id))
        .limit(1);

      if (existingSchedule) {
        await masterDb
          .update(masterSchema.digestSchedules)
          .set({
            enabled: body.enabled,
            sendHour: body.sendHour,
            timezone,
            updatedAt: new Date(),
          })
          .where(eq(masterSchema.digestSchedules.id, existingSchedule.id));
      } else {
        await masterDb.insert(masterSchema.digestSchedules).values({
          id: generateId('ds'),
          workspaceId: workspace.id,
          enabled: body.enabled,
          sendHour: body.sendHour,
          timezone,
        });
      }
    }

    publishEntityEvent({
      c,
      entityType: 'digest_settings',
      entityId: settings.id,
      action: 'updated',
      data: settings as unknown as Record<string, unknown>,
    });

    return success(c, settings);
  } catch (err) {
    console.error('[app-api/digest-settings] update failed:', err);
    return error.internal(c, 'Failed to update digest settings');
  }
});

export const digestSettingsRoutes = app;
