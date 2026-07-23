/**
 * User preferences — singleton per (workspace, user). One row in
 * `user_preferences` keyed by `user_id`. The current user is derived from the
 * Clerk JWT (`c.get('userId')`), so there is no `/:id` path: the user can only
 * read and write their own preferences.
 *
 * Schema: `packages/core/db/src/schema/user-preferences.ts`
 *
 * No explicit permission — every authenticated user manages their own prefs.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.userPreferences;

const workingHoursSchema = z.record(z.string(), z.any()).optional();

const updatePreferencesSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  fontSize: z.number().int().min(12).max(20).optional(),
  language: z.string().optional(),
  dateFormat: z.string().optional(),
  timeFormat: z.string().optional(),
  timezone: z.string().optional(),
  notifications: z
    .object({
      email: z.boolean().optional(),
      push: z.boolean().optional(),
      desktop: z.boolean().optional(),
      sound: z.boolean().optional(),
    })
    .optional(),
  // Schemaless on purpose — the platform stores feature-specific blocks here
  // (homeWidgets, profile, sidebarAppOrder, …). The PUT handler MERGES the
  // payload into the existing JSONB to preserve siblings.
  uiPreferences: z.record(z.string(), z.any()).optional(),
  workingHours: workingHoursSchema,
});

type Preferences = {
  theme: string;
  fontSize: number;
  language: string;
  dateFormat: string;
  timeFormat: string;
  timezone: string;
  notifications: Record<string, unknown>;
  uiPreferences: Record<string, unknown>;
  workingHours: unknown;
};

function toResponse(row: typeof t.$inferSelect | undefined): Preferences {
  return {
    theme: row?.theme || 'system',
    fontSize: row?.fontSize ?? 16,
    language: row?.language || 'en',
    dateFormat: row?.dateFormat || 'MM/DD/YYYY',
    timeFormat: row?.timeFormat || '12h',
    timezone: row?.timezone || 'UTC',
    notifications: (row?.notifications as Record<string, unknown>) || {},
    uiPreferences: (row?.uiPreferences as Record<string, unknown>) || {},
    workingHours: row?.workingHours ?? null,
  };
}

/** GET /api/user-preferences — current user's preferences. Returns defaults when no row exists. */
app.get('/', async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);

  try {
    const db = c.get('tenantDb');
    const [row] = await db
      .select()
      .from(t)
      .where(and(eq(t.userId, userId), isNull(t.deletedAt)))
      .limit(1);

    return success(c, toResponse(row));
  } catch (err) {
    console.error('[app-api/user-preferences] get failed:', err);
    return error.internal(c, 'Failed to fetch user preferences');
  }
});

/** PUT /api/user-preferences — upsert. `uiPreferences` is merged into the existing JSONB. */
app.put('/', zValidator('json', updatePreferencesSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);

  const data = c.req.valid('json');

  try {
    const db = c.get('tenantDb');
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.userId, userId), isNull(t.deletedAt)))
      .limit(1);

    if (existing) {
      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (data.theme !== undefined) updateData.theme = data.theme;
      if (data.fontSize !== undefined) updateData.fontSize = data.fontSize;
      if (data.language !== undefined) updateData.language = data.language;
      if (data.dateFormat !== undefined) updateData.dateFormat = data.dateFormat;
      if (data.timeFormat !== undefined) updateData.timeFormat = data.timeFormat;
      if (data.timezone !== undefined) updateData.timezone = data.timezone;
      if (data.notifications !== undefined) updateData.notifications = data.notifications;
      if (data.uiPreferences !== undefined) {
        // Merge — preserves homeWidgets, profile, sidebarAppOrder, etc.
        const current = (existing.uiPreferences as Record<string, unknown>) || {};
        updateData.uiPreferences = { ...current, ...data.uiPreferences };
      }
      if (data.workingHours !== undefined) updateData.workingHours = data.workingHours;

      await db.update(t).set(updateData).where(eq(t.id, existing.id));

      const [updated] = await db.select().from(t).where(eq(t.id, existing.id)).limit(1);
      return success(c, toResponse(updated));
    }

    const id = generateId('upref');
    const now = new Date();
    await db.insert(t).values({
      id,
      userId,
      theme: data.theme ?? 'system',
      fontSize: data.fontSize ?? 16,
      language: data.language ?? 'en',
      dateFormat: data.dateFormat ?? 'MM/DD/YYYY',
      timeFormat: data.timeFormat ?? '12h',
      timezone: data.timezone ?? 'UTC',
      notifications: data.notifications ?? {},
      uiPreferences: data.uiPreferences ?? {},
      workingHours: data.workingHours ?? null,
      createdAt: now,
      updatedAt: now,
    } as typeof t.$inferInsert);

    const [created] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    return success(c, toResponse(created), 201);
  } catch (err) {
    console.error('[app-api/user-preferences] update failed:', err);
    return error.internal(c, 'Failed to update user preferences');
  }
});

/** PATCH /api/user-preferences/theme — quick theme-only update. */
app.patch(
  '/theme',
  zValidator('json', z.object({ theme: z.enum(['light', 'dark', 'system']) })),
  async (c) => {
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);

    const { theme } = c.req.valid('json');
    try {
      const db = c.get('tenantDb');
      const [existing] = await db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.userId, userId), isNull(t.deletedAt)))
        .limit(1);

      if (existing) {
        await db.update(t).set({ theme, updatedAt: new Date() }).where(eq(t.id, existing.id));
      } else {
        const id = generateId('upref');
        const now = new Date();
        await db.insert(t).values({ id, userId, theme, createdAt: now, updatedAt: now } as typeof t.$inferInsert);
      }
      return success(c, { theme });
    } catch (err) {
      console.error('[app-api/user-preferences] theme update failed:', err);
      return error.internal(c, 'Failed to update theme');
    }
  },
);

/** PATCH /api/user-preferences/font-size — quick font-size-only update. */
app.patch(
  '/font-size',
  zValidator('json', z.object({ fontSize: z.number().int().min(12).max(20) })),
  async (c) => {
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);

    const { fontSize } = c.req.valid('json');
    try {
      const db = c.get('tenantDb');
      const [existing] = await db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.userId, userId), isNull(t.deletedAt)))
        .limit(1);

      if (existing) {
        await db.update(t).set({ fontSize, updatedAt: new Date() }).where(eq(t.id, existing.id));
      } else {
        const id = generateId('upref');
        const now = new Date();
        await db.insert(t).values({ id, userId, fontSize, createdAt: now, updatedAt: now } as typeof t.$inferInsert);
      }
      return success(c, { fontSize });
    } catch (err) {
      console.error('[app-api/user-preferences] font-size update failed:', err);
      return error.internal(c, 'Failed to update font size');
    }
  },
);

export const userPreferencesRoutes = app;
