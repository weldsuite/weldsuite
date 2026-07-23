/**
 * WeldMeet — Waitlist Service (app-api)
 *
 * Manages the waitingRoom queue for meetings. Portal guests are enqueued by
 * POST /api/meeting/join when `meeting.waitingRoom === true`; the host
 * decides admit/deny via the host UI.
 *
 * Ported from apps/core-api/src/services/weldmeet/waitlist.ts.
 */

import { eq, and, desc } from 'drizzle-orm';
import type { Database } from '../../db';
import { schema } from '../../db';
import { generateId } from '../../lib/id';

export type WaitlistEntry = typeof schema.meetingSessionWaitlist.$inferSelect;

export async function listWaitlist(
  db: Database,
  meetingId: string,
  status: 'pending' | 'admitted' | 'denied' | 'all' = 'pending',
): Promise<WaitlistEntry[]> {
  const { meetingSessionWaitlist } = schema;
  const where =
    status === 'all'
      ? eq(meetingSessionWaitlist.meetingId, meetingId)
      : and(
          eq(meetingSessionWaitlist.meetingId, meetingId),
          eq(meetingSessionWaitlist.status, status),
        );
  return db
    .select()
    .from(meetingSessionWaitlist)
    .where(where)
    .orderBy(desc(meetingSessionWaitlist.requestedAt));
}

export async function getWaitlistEntry(
  db: Database,
  id: string,
): Promise<WaitlistEntry | null> {
  const { meetingSessionWaitlist } = schema;
  const [row] = await db
    .select()
    .from(meetingSessionWaitlist)
    .where(eq(meetingSessionWaitlist.id, id))
    .limit(1);
  return row ?? null;
}

export async function findPendingByEmail(
  db: Database,
  meetingId: string,
  email: string,
): Promise<WaitlistEntry | null> {
  const { meetingSessionWaitlist } = schema;
  const [row] = await db
    .select()
    .from(meetingSessionWaitlist)
    .where(
      and(
        eq(meetingSessionWaitlist.meetingId, meetingId),
        eq(meetingSessionWaitlist.email, email.toLowerCase()),
        eq(meetingSessionWaitlist.status, 'pending'),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function enqueueWaitlist(
  db: Database,
  params: {
    meetingId: string;
    sessionId?: string;
    name: string;
    email: string;
    contactId?: string;
  },
): Promise<WaitlistEntry> {
  const { meetingSessionWaitlist } = schema;

  // Reuse a pending entry from the same email — guests sometimes refresh
  // their browser; we don't want a duplicate row per refresh.
  const existing = await findPendingByEmail(db, params.meetingId, params.email);
  if (existing) return existing;

  const id = generateId('mwl');
  const now = new Date();
  await db.insert(meetingSessionWaitlist).values({
    id,
    meetingId: params.meetingId,
    sessionId: params.sessionId,
    name: params.name,
    email: params.email.toLowerCase(),
    contactId: params.contactId,
    status: 'pending',
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  const [row] = await db
    .select()
    .from(meetingSessionWaitlist)
    .where(eq(meetingSessionWaitlist.id, id))
    .limit(1);
  return row!;
}

export type DecisionOutcome =
  | { kind: 'ok'; entry: WaitlistEntry }
  | { kind: 'not-found' }
  | { kind: 'already-decided' };

export async function decideWaitlist(
  db: Database,
  params: { id: string; decidedBy: string; admit: boolean },
): Promise<DecisionOutcome> {
  const existing = await getWaitlistEntry(db, params.id);
  if (!existing) return { kind: 'not-found' };
  if (existing.status !== 'pending') return { kind: 'already-decided' };

  const { meetingSessionWaitlist } = schema;
  const now = new Date();
  await db
    .update(meetingSessionWaitlist)
    .set({
      status: params.admit ? 'admitted' : 'denied',
      decidedBy: params.decidedBy,
      decidedAt: now,
      updatedAt: now,
    })
    .where(eq(meetingSessionWaitlist.id, params.id));

  const updated = await getWaitlistEntry(db, params.id);
  return { kind: 'ok', entry: updated! };
}
