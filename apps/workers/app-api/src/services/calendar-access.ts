/**
 * Calendar access + sharing.
 *
 * Ported from apps/api-worker/src/routes/calendar/calendars.ts (W5b of the
 * legacy-worker phase-out). Pure functions, no Hono context.
 *
 * The access model here is the one WeldCalendar's UI actually gates on, and
 * it is NOT the plain owner-scoping app-api's generated calendar shells used:
 *
 *   accessible calendars = calendars you own  ∪  calendars shared with you
 *
 * Every list/read of calendars *and* of the events inside them resolves
 * through this set. `isOwn` + `permission` are derived (not columns) and are
 * read by the sidebar, the event dialog and the calendar view.
 */

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../db';
import { schema } from '../db';
import { generateId } from '../lib/id';

export type CalendarPermission = 'view' | 'edit' | 'manage';

export type CalendarRow = typeof schema.calendars.$inferSelect;

export interface AnnotatedCalendar extends CalendarRow {
  /** True when the caller owns the calendar (vs. it being shared with them). */
  isOwn: boolean;
  /** Owners always get `manage`; sharees get whatever the share row grants. */
  permission: CalendarPermission;
}

/**
 * Every calendar id the user may read: their own plus any shared with them.
 * This is the tenant-scoped access boundary for calendar events — the tenant
 * DB itself is already per-workspace, so no workspaceId predicate is needed
 * (and none of these tables carry one).
 */
export async function getAccessibleCalendarIds(
  db: Database,
  userId: string,
): Promise<string[]> {
  const { calendars, calendarShares } = schema;

  const [ownCalendars, sharedCalendars] = await Promise.all([
    db
      .select({ id: calendars.id })
      .from(calendars)
      .where(and(eq(calendars.ownerId, userId), isNull(calendars.deletedAt))),
    db
      .select({ calendarId: calendarShares.calendarId })
      .from(calendarShares)
      .where(and(eq(calendarShares.sharedWithId, userId), isNull(calendarShares.deletedAt))),
  ]);

  return [...ownCalendars.map((c) => c.id), ...sharedCalendars.map((s) => s.calendarId)];
}

/**
 * Narrow a caller-supplied `calendarIds` filter to the ones they may actually
 * read. Returns the full accessible set when no filter is given.
 */
export async function resolveRequestedCalendarIds(
  db: Database,
  userId: string,
  requested: string | undefined,
): Promise<string[]> {
  const accessible = await getAccessibleCalendarIds(db, userId);
  if (!requested) return accessible;
  const wanted = requested.split(',').map((s) => s.trim()).filter(Boolean);
  return wanted.filter((id) => accessible.includes(id));
}

/**
 * List the calendars visible to a user: their own first (default calendar
 * pinned to the top), then the ones shared with them — each annotated with
 * `isOwn` + `permission`.
 */
export async function listCalendarsForUser(
  db: Database,
  userId: string,
): Promise<AnnotatedCalendar[]> {
  const { calendars, calendarShares } = schema;

  const shares = await db
    .select({ calendarId: calendarShares.calendarId, permission: calendarShares.permission })
    .from(calendarShares)
    .where(and(eq(calendarShares.sharedWithId, userId), isNull(calendarShares.deletedAt)));

  const sharedCalendarIds = shares.map((s) => s.calendarId);
  const permissionMap = new Map(shares.map((s) => [s.calendarId, s.permission]));

  const ownCalendars = await db
    .select()
    .from(calendars)
    .where(and(eq(calendars.ownerId, userId), isNull(calendars.deletedAt)))
    .orderBy(desc(calendars.isDefault), calendars.name);

  let sharedCalendars: CalendarRow[] = [];
  if (sharedCalendarIds.length > 0) {
    sharedCalendars = await db
      .select()
      .from(calendars)
      .where(and(inArray(calendars.id, sharedCalendarIds), isNull(calendars.deletedAt)))
      .orderBy(calendars.name);
  }

  return [
    ...ownCalendars.map((cal) => ({ ...cal, isOwn: true, permission: 'manage' as const })),
    ...sharedCalendars.map((cal) => ({
      ...cal,
      isOwn: false,
      permission: (permissionMap.get(cal.id) as CalendarPermission | undefined) ?? 'view',
    })),
  ];
}

/** How a given user may touch a calendar, or null when they may not see it. */
export async function getCalendarAccess(
  db: Database,
  calendarId: string,
  userId: string,
): Promise<{ calendar: CalendarRow; isOwn: boolean; permission: CalendarPermission } | null> {
  const { calendars, calendarShares } = schema;

  const [calendar] = await db
    .select()
    .from(calendars)
    .where(and(eq(calendars.id, calendarId), isNull(calendars.deletedAt)))
    .limit(1);

  if (!calendar) return null;
  if (calendar.ownerId === userId) return { calendar, isOwn: true, permission: 'manage' };

  const [share] = await db
    .select({ permission: calendarShares.permission })
    .from(calendarShares)
    .where(
      and(
        eq(calendarShares.calendarId, calendarId),
        eq(calendarShares.sharedWithId, userId),
        isNull(calendarShares.deletedAt),
      ),
    )
    .limit(1);

  if (!share) return null;
  return {
    calendar,
    isOwn: false,
    permission: (share.permission as CalendarPermission | undefined) ?? 'view',
  };
}

/**
 * Fetch-or-create the user's default calendar.
 *
 * NOTE: `@weldsuite/db/lib/calendar-sync` also exports an `ensureDefaultCalendar`,
 * but it returns only the id and does not set the default colour. The
 * WeldCalendar route contract is the full row (the sidebar renders its colour),
 * so this mirrors the legacy route rather than delegating.
 *
 * `created` distinguishes the legacy 200 (already existed) from 201 (made one).
 */
export async function ensureDefaultCalendar(
  db: Database,
  userId: string,
): Promise<{ calendar: CalendarRow; created: boolean }> {
  const { calendars } = schema;

  const [existing] = await db
    .select()
    .from(calendars)
    .where(
      and(
        eq(calendars.ownerId, userId),
        eq(calendars.isDefault, true),
        isNull(calendars.deletedAt),
      ),
    )
    .limit(1);

  if (existing) return { calendar: existing, created: false };

  const now = new Date();
  const [created] = await db
    .insert(calendars)
    .values({
      id: generateId('cal'),
      name: 'My Calendar',
      color: '#3b82f6',
      ownerId: userId,
      isDefault: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return { calendar: created, created: true };
}

// ── Shares ───────────────────────────────────────────────────────────────

export type CalendarShareRow = typeof schema.calendarShares.$inferSelect;

/** List the (non-deleted) share rows for a calendar. */
export async function listCalendarShares(
  db: Database,
  calendarId: string,
): Promise<CalendarShareRow[]> {
  const { calendarShares } = schema;
  return db
    .select()
    .from(calendarShares)
    .where(and(eq(calendarShares.calendarId, calendarId), isNull(calendarShares.deletedAt)));
}

/**
 * Share a calendar with a member, or update the permission of an existing
 * share. `created` is false when an existing share was updated in place.
 */
export async function upsertCalendarShare(
  db: Database,
  params: {
    calendarId: string;
    sharedWithId: string;
    permission: CalendarPermission;
    sharedById: string;
  },
): Promise<{ id: string; permission: CalendarPermission; created: boolean }> {
  const { calendarShares } = schema;

  const [existing] = await db
    .select({ id: calendarShares.id })
    .from(calendarShares)
    .where(
      and(
        eq(calendarShares.calendarId, params.calendarId),
        eq(calendarShares.sharedWithId, params.sharedWithId),
        isNull(calendarShares.deletedAt),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(calendarShares)
      .set({ permission: params.permission, updatedAt: new Date() })
      .where(eq(calendarShares.id, existing.id));
    return { id: existing.id, permission: params.permission, created: false };
  }

  const id = generateId('csh');
  const now = new Date();
  await db.insert(calendarShares).values({
    id,
    calendarId: params.calendarId,
    sharedWithId: params.sharedWithId,
    permission: params.permission,
    sharedById: params.sharedById,
    createdAt: now,
    updatedAt: now,
  });

  return { id, permission: params.permission, created: true };
}

/** Soft-delete a share. Scoped by calendarId so a stray shareId can't escape. */
export async function removeCalendarShare(
  db: Database,
  calendarId: string,
  shareId: string,
): Promise<void> {
  const { calendarShares } = schema;
  await db
    .update(calendarShares)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(calendarShares.id, shareId), eq(calendarShares.calendarId, calendarId)));
}
