/**
 * Working hours — /api/working-hours. Per-user working-hours schedule stored
 * on tenant `user_preferences.working_hours`.
 *
 * Ported from apps/api-worker (W3 legacy-worker phase-out):
 *   - GET  /                    ← GET  /settings/working-hours (self)
 *   - PUT  /                    ← PUT  /settings/working-hours (self)
 *   - GET  /team                ← GET  /settings/team/working-hours
 *   - GET  /members/:memberId   ← GET  /settings/members/:memberId/working-hours
 *   - PUT  /members/:memberId   ← PUT  /settings/members/:memberId/working-hours
 *
 * Permissions (parity with legacy): self read is baseline general:read; self
 * write requires working-hours:edit-self OR team:update (admins can never
 * lock themselves out); member/team admin surfaces use team:read/team:update.
 *
 * Entity events: none — `working_hours` is not in the packages/core/entity-events
 * catalog.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const { userPreferences, workspaceMembers } = schema;

const dayHoursSchema = z.object({
  isOpen: z.boolean(),
  openTime: z.string().optional(),
  closeTime: z.string().optional(),
  breaks: z
    .array(
      z.object({
        start: z.string(),
        end: z.string(),
      }),
    )
    .optional(),
});

const workingHoursSchema = z.object({
  monday: dayHoursSchema.optional(),
  tuesday: dayHoursSchema.optional(),
  wednesday: dayHoursSchema.optional(),
  thursday: dayHoursSchema.optional(),
  friday: dayHoursSchema.optional(),
  saturday: dayHoursSchema.optional(),
  sunday: dayHoursSchema.optional(),
});

const updateWorkingHoursSchema = z.object({
  workingHours: workingHoursSchema,
});

type WorkingHours = z.infer<typeof workingHoursSchema>;

/** Upsert the working-hours blob on a user's preferences row. */
async function upsertWorkingHours(
  db: Variables['tenantDb'],
  userId: string,
  workingHours: WorkingHours,
): Promise<void> {
  const [existing] = await db
    .select({ id: userPreferences.id })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), isNull(userPreferences.deletedAt)))
    .limit(1);

  if (existing) {
    await db
      .update(userPreferences)
      .set({ workingHours, updatedAt: new Date() })
      .where(eq(userPreferences.id, existing.id));
  } else {
    await db.insert(userPreferences).values({
      id: generateId('upref'),
      userId,
      workingHours,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

/**
 * GET / — current user's working hours (null when unset).
 */
app.get('/', requirePermission('general:read'), async (c) => {
  const userId = c.get('userId');

  try {
    const db = c.get('tenantDb');

    const [prefs] = await db
      .select({ workingHours: userPreferences.workingHours })
      .from(userPreferences)
      .where(and(eq(userPreferences.userId, userId), isNull(userPreferences.deletedAt)))
      .limit(1);

    return success(c, { workingHours: prefs?.workingHours || null });
  } catch (err) {
    console.error('[app-api/working-hours] Failed to fetch working hours:', err);
    return error.internal(c, 'Failed to fetch working hours');
  }
});

/**
 * PUT / — update current user's working hours.
 * Requires `working-hours:edit-self`; admins with `team:update` also pass.
 */
app.put(
  '/',
  requirePermission('working-hours:edit-self', 'team:update'),
  zValidator('json', updateWorkingHoursSchema),
  async (c) => {
    const userId = c.get('userId');
    const { workingHours } = c.req.valid('json');

    try {
      const db = c.get('tenantDb');
      await upsertWorkingHours(db, userId, workingHours);
      return success(c, { workingHours });
    } catch (err) {
      console.error('[app-api/working-hours] Failed to update working hours:', err);
      return error.internal(c, 'Failed to update working hours');
    }
  },
);

/**
 * GET /team — all active members' working hours (admin overview).
 */
app.get('/team', requirePermission('team:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    const db = c.get('tenantDb');

    const members = await db
      .select({
        id: workspaceMembers.id,
        userId: workspaceMembers.userId,
        name: workspaceMembers.name,
        email: workspaceMembers.email,
        picture: workspaceMembers.picture,
        workingHours: userPreferences.workingHours,
      })
      .from(workspaceMembers)
      .leftJoin(
        userPreferences,
        and(
          eq(workspaceMembers.userId, userPreferences.userId),
          isNull(userPreferences.deletedAt),
        ),
      )
      .where(and(eq(workspaceMembers.status, 'ACTIVE'), isNull(workspaceMembers.deletedAt)))
      .orderBy(workspaceMembers.name);

    return success(c, members);
  } catch (err) {
    console.error('[app-api/working-hours] Failed to fetch team working hours:', err);
    return error.internal(c, 'Failed to fetch team working hours');
  }
});

/**
 * GET /members/:memberId — a member's working hours (admin).
 */
app.get('/members/:memberId', requirePermission('team:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const memberId = c.req.param('memberId');

  try {
    const db = c.get('tenantDb');

    const [member] = await db
      .select({ userId: workspaceMembers.userId, name: workspaceMembers.name })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.id, memberId), isNull(workspaceMembers.deletedAt)))
      .limit(1);

    if (!member) return error.notFound(c, 'Member', memberId);

    const [prefs] = await db
      .select({ workingHours: userPreferences.workingHours })
      .from(userPreferences)
      .where(and(eq(userPreferences.userId, member.userId), isNull(userPreferences.deletedAt)))
      .limit(1);

    return success(c, {
      memberId,
      memberName: member.name,
      workingHours: prefs?.workingHours || null,
    });
  } catch (err) {
    console.error('[app-api/working-hours] Failed to fetch member working hours:', err);
    return error.internal(c, 'Failed to fetch member working hours');
  }
});

/**
 * PUT /members/:memberId — set a member's working hours (admin).
 */
app.put(
  '/members/:memberId',
  requirePermission('team:update'),
  zValidator('json', updateWorkingHoursSchema),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);

    const memberId = c.req.param('memberId');
    const { workingHours } = c.req.valid('json');

    try {
      const db = c.get('tenantDb');

      const [member] = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.id, memberId), isNull(workspaceMembers.deletedAt)))
        .limit(1);

      if (!member) return error.notFound(c, 'Member', memberId);

      await upsertWorkingHours(db, member.userId, workingHours);

      return success(c, { memberId, workingHours });
    } catch (err) {
      console.error('[app-api/working-hours] Failed to update member working hours:', err);
      return error.internal(c, 'Failed to update member working hours');
    }
  },
);

export const workingHoursRoutes = app;
