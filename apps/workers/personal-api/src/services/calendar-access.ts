/**
 * Personal calendar access — owner-only (no shares in v1).
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { PersonalDatabase } from '../db';
import { personalSchema } from '../db';
import { generateId } from '../lib/id';

export type CalendarPermission = 'view' | 'edit' | 'manage';
export type CalendarRow = typeof personalSchema.personalCalendars.$inferSelect;

export interface AnnotatedCalendar extends CalendarRow {
  isOwn: true;
  permission: 'manage';
}

export async function listCalendarsForAccount(
  db: PersonalDatabase,
  personalAccountId: string,
): Promise<AnnotatedCalendar[]> {
  const { personalCalendars } = personalSchema;
  const rows = await db
    .select()
    .from(personalCalendars)
    .where(
      and(
        eq(personalCalendars.personalAccountId, personalAccountId),
        isNull(personalCalendars.deletedAt),
      ),
    )
    .orderBy(desc(personalCalendars.isDefault), personalCalendars.name);

  return rows.map((cal) => ({ ...cal, isOwn: true as const, permission: 'manage' as const }));
}

export async function getCalendarForAccount(
  db: PersonalDatabase,
  personalAccountId: string,
  calendarId: string,
): Promise<CalendarRow | null> {
  const { personalCalendars } = personalSchema;
  const [row] = await db
    .select()
    .from(personalCalendars)
    .where(
      and(
        eq(personalCalendars.id, calendarId),
        eq(personalCalendars.personalAccountId, personalAccountId),
        isNull(personalCalendars.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listCalendarIdsForAccount(
  db: PersonalDatabase,
  personalAccountId: string,
): Promise<string[]> {
  const rows = await listCalendarsForAccount(db, personalAccountId);
  return rows.map((c) => c.id);
}

export async function resolveRequestedCalendarIds(
  db: PersonalDatabase,
  personalAccountId: string,
  requested: string | undefined,
): Promise<string[]> {
  const accessible = await listCalendarIdsForAccount(db, personalAccountId);
  if (!requested) return accessible;
  const wanted = requested.split(',').map((s) => s.trim()).filter(Boolean);
  return wanted.filter((id) => accessible.includes(id));
}

export async function ensureDefaultCalendar(
  db: PersonalDatabase,
  personalAccountId: string,
  ownerId: string,
): Promise<{ calendar: CalendarRow; created: boolean }> {
  const { personalCalendars } = personalSchema;

  const [existing] = await db
    .select()
    .from(personalCalendars)
    .where(
      and(
        eq(personalCalendars.personalAccountId, personalAccountId),
        eq(personalCalendars.isDefault, true),
        isNull(personalCalendars.deletedAt),
      ),
    )
    .limit(1);

  if (existing) return { calendar: existing, created: false };

  const now = new Date();
  const [created] = await db
    .insert(personalCalendars)
    .values({
      id: generateId('cal'),
      personalAccountId,
      name: 'My Calendar',
      color: '#3b82f6',
      ownerId,
      isDefault: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return { calendar: created!, created: true };
}
