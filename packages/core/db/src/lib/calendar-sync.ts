/**
 * Calendar Sync & Auto-Scheduling for Tasks
 *
 * When a task is created, the system automatically finds a free slot in the
 * user's working hours and creates a timed calendar event.
 *
 * - Tasks WITH a dueDate: slot is found between now and the deadline
 *   (low priority searches backward from deadline; medium+ searches forward
 *   from now). Falls back to all-day on the deadline if no slot fits.
 *
 * - Tasks WITHOUT a dueDate: slot is found going forward from now within a
 *   60-day window (extendable to 90 if no slot fits). No fake deadline is
 *   stored; the placement is allowed to slide as higher-priority tasks
 *   arrive and trigger cascading bumps.
 *
 * - Cascading bumps: a higher-priority incoming task can displace a
 *   lower-priority auto-scheduled event. The displaced event is itself
 *   rescheduled and may bump an even-lower-priority event in turn, up to
 *   a depth limit of 5 with cycle protection.
 */

import { eq, and, isNull, gte, lte, or, not, inArray, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../schema';
import type { WorkingHours, DayHours } from '../schema/helpdesk-agents';

type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

const DEFAULT_DURATION_MINUTES = 30;
const MAX_SEARCH_DAYS = 14;
const MAX_SEARCH_DAYS_NO_DEADLINE = 60;
const MAX_SEARCH_DAYS_NO_DEADLINE_EXTENDED = 90;
const SLOT_STEP_MINUTES = 15;
const MAX_CASCADE_DEPTH = 5;

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

// ── ID generation ───────────────────────────────────────────────────────

function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}

// ── Priority mapping ───────────────────────────────────────────────────

type CalendarPriority = 'low' | 'normal' | 'high' | 'urgent';

const PRIORITY_WEIGHT: Record<string, number> = {
  critical: 4, urgent: 4,
  high: 3,
  medium: 2, normal: 2,
  low: 1,
  none: 0,
};

function priorityWeight(p: string | null | undefined): number {
  return PRIORITY_WEIGHT[p ?? 'medium'] ?? 2;
}

function taskPriorityToCalendarPriority(taskPriority: string | null | undefined): CalendarPriority {
  switch (taskPriority) {
    case 'critical': return 'urgent';
    case 'high': return 'high';
    case 'low': return 'low';
    case 'none': return 'low';
    default: return 'normal';
  }
}

const DEFAULT_WORKING_HOURS: WorkingHours = {
  monday: { isOpen: true, openTime: '09:00', closeTime: '17:00' },
  tuesday: { isOpen: true, openTime: '09:00', closeTime: '17:00' },
  wednesday: { isOpen: true, openTime: '09:00', closeTime: '17:00' },
  thursday: { isOpen: true, openTime: '09:00', closeTime: '17:00' },
  friday: { isOpen: true, openTime: '09:00', closeTime: '17:00' },
  saturday: { isOpen: false },
  sunday: { isOpen: false },
};

// ── Ensure default calendar exists ──────────────────────────────────────

export async function ensureDefaultCalendar(db: Database, userId: string): Promise<string> {
  const { calendars } = schema;

  const [existing] = await db
    .select({ id: calendars.id })
    .from(calendars)
    .where(
      and(
        eq(calendars.ownerId, userId),
        eq(calendars.isDefault, true),
        isNull(calendars.deletedAt),
      )
    )
    .limit(1);

  if (existing) {
    return existing.id;
  }

  const id = generateId('cal');
  const now = new Date();

  await db.insert(calendars).values({
    id,
    name: 'My Calendar',
    ownerId: userId,
    isDefault: true,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  return id;
}

// ── Get user scheduling context ─────────────────────────────────────────

interface SchedulingContext {
  timezone: string;
  workingHours: WorkingHours;
}

async function getUserSchedulingContext(db: Database, userId: string): Promise<SchedulingContext> {
  const { userPreferences } = schema;

  const [prefs] = await db
    .select({
      timezone: userPreferences.timezone,
      workingHours: userPreferences.workingHours,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);

  return {
    timezone: prefs?.timezone || 'UTC',
    workingHours: (prefs?.workingHours as WorkingHours) || DEFAULT_WORKING_HOURS,
  };
}

// ── Find free slot algorithm ────────────────────────────────────────────

type SearchDirection = 'forward' | 'backward' | 'auto';

interface FindSlotParams {
  userId: string;
  deadline: Date;
  durationMinutes: number;
  timezone: string;
  workingHours: WorkingHours;
  priority?: string;
  excludeEventIds?: string[];
  /**
   * 'forward' = earliest slot, 'backward' = latest slot before deadline,
   * 'auto' = forward for medium+, backward for low. Default 'auto'.
   */
  direction?: SearchDirection;
  /** If set, search starts from this date instead of now. */
  earliestStart?: Date;
}

interface TimeSlot {
  startTime: Date;
  endTime: Date;
}

interface ExistingEvent {
  id: string;
  startTime: Date | string;
  endTime: Date | string | null;
  priority: string | null;
  customFields: Record<string, any> | null;
}

function parseTime(timeStr: string): { hours: number; minutes: number } {
  const parts = timeStr.split(':').map(Number);
  return { hours: parts[0] ?? 0, minutes: parts[1] ?? 0 };
}

function roundUpTo15Min(date: Date): Date {
  const result = new Date(date);
  const minutes = result.getMinutes();
  const remainder = minutes % SLOT_STEP_MINUTES;
  if (remainder !== 0) {
    result.setMinutes(minutes + (SLOT_STEP_MINUTES - remainder));
    result.setSeconds(0, 0);
  } else {
    result.setSeconds(0, 0);
  }
  return result;
}

function subtractBreaks(
  windowStart: Date,
  windowEnd: Date,
  breaks: { start: string; end: string }[],
  baseDate: Date,
): { start: Date; end: Date }[] {
  let windows: { start: Date; end: Date }[] = [{ start: windowStart, end: windowEnd }];

  for (const brk of breaks) {
    const brkStart = new Date(baseDate);
    const bs = parseTime(brk.start);
    brkStart.setHours(bs.hours, bs.minutes, 0, 0);

    const brkEnd = new Date(baseDate);
    const be = parseTime(brk.end);
    brkEnd.setHours(be.hours, be.minutes, 0, 0);

    const newWindows: { start: Date; end: Date }[] = [];
    for (const w of windows) {
      if (brkEnd <= w.start || brkStart >= w.end) {
        newWindows.push(w);
      } else {
        if (brkStart > w.start) {
          newWindows.push({ start: w.start, end: brkStart });
        }
        if (brkEnd < w.end) {
          newWindows.push({ start: brkEnd, end: w.end });
        }
      }
    }
    windows = newWindows;
  }

  return windows;
}

export async function findFreeSlot(
  db: Database,
  params: FindSlotParams,
): Promise<TimeSlot | null> {
  const { calendarEvents } = schema;
  const { userId, deadline, durationMinutes, workingHours, priority, excludeEventIds, direction, earliestStart } = params;
  const durationMs = durationMinutes * 60000;
  const weight = priorityWeight(priority);

  const now = earliestStart ?? new Date();
  if (deadline <= now) return null;

  const searchEnd = new Date(deadline);

  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);

  const dayEnd = new Date(searchEnd);
  dayEnd.setHours(23, 59, 59, 999);

  // ── Busy-block union ────────────────────────────────────────────────────
  // Source 1: calendarEvents (status='confirmed', owned by user).
  //   This already includes inbound Google Calendar events: the integration
  //   orchestrator (outbound-calendar-sync / orchestrator.ts) writes fetched
  //   Google Calendar events directly into the calendarEvents table via the
  //   'calendar_event' entity type mapping. No extra union needed for those.
  //
  // Source 2: meetings (WeldMeet) — treated as priority='high' so cascading
  //   bumps can never displace them. Matched where the user is the organizer
  //   OR appears in the attendees JSONB array as a workspaceMemberId.
  //   Status filter excludes terminal states.
  // ────────────────────────────────────────────────────────────────────────

  const { meetings, workspaceMembers } = schema;

  // Resolve the user's workspaceMemberId (needed for JSONB attendee matching)
  const [memberRow] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);
  const workspaceMemberId: string | null = memberRow?.id ?? null;

  const calendarEventRows: ExistingEvent[] = await db
    .select({
      id: calendarEvents.id,
      startTime: calendarEvents.startTime,
      endTime: calendarEvents.endTime,
      priority: calendarEvents.priority,
      customFields: calendarEvents.customFields,
    })
    .from(calendarEvents)
    .where(and(
      isNull(calendarEvents.deletedAt),
      eq(calendarEvents.organizerId, userId),
      eq(calendarEvents.status, 'confirmed'),
      gte(calendarEvents.startTime, dayStart),
      lte(calendarEvents.startTime, dayEnd),
    ));

  // Fetch meetings busy blocks for this user in the search window.
  // Meetings are given priority='high' so the slot-walker treats them as
  // immovable — they must not be displaced by cascading task bumps.
  const meetingConditions = [
    isNull(meetings.deletedAt),
    not(inArray(meetings.status, ['cancelled', 'completed', 'failed'])),
    gte(meetings.scheduledStart, dayStart),
    lte(meetings.scheduledStart, dayEnd),
    or(
      eq(meetings.organizerId, userId),
      workspaceMemberId
        ? sql`${meetings.attendees} @> ${JSON.stringify([{ workspaceMemberId }])}::jsonb`
        : sql`false`,
    )!,
  ];

  const meetingRows = await db
    .select({
      id: meetings.id,
      startTime: meetings.scheduledStart,
      endTime: meetings.scheduledEnd,
    })
    .from(meetings)
    .where(and(...meetingConditions));

  // Normalize meeting rows into ExistingEvent shape with priority='high'
  const meetingBusyBlocks: ExistingEvent[] = meetingRows
    .filter((m): m is typeof m & { startTime: Date } => m.startTime != null)
    .map((m) => ({
      id: m.id,
      startTime: m.startTime,
      endTime: m.endTime,
      priority: 'high' as const,
      customFields: null,
    }));

  const existingEvents: ExistingEvent[] = [...calendarEventRows, ...meetingBusyBlocks];

  function getWindowsForDay(day: Date): { start: Date; end: Date }[] {
    const dayName = DAY_NAMES[day.getDay()];
    if (!dayName) return [];
    const dayHours = workingHours[dayName] as DayHours | undefined;

    if (!dayHours?.isOpen || !dayHours.openTime || !dayHours.closeTime) return [];

    const open = parseTime(dayHours.openTime);
    const close = parseTime(dayHours.closeTime);

    const windowStart = new Date(day);
    windowStart.setHours(open.hours, open.minutes, 0, 0);

    const windowEnd = new Date(day);
    windowEnd.setHours(close.hours, close.minutes, 0, 0);

    let windows = dayHours.breaks?.length
      ? subtractBreaks(windowStart, windowEnd, dayHours.breaks, day)
      : [{ start: windowStart, end: windowEnd }];

    if (day.toDateString() === now.toDateString()) {
      const earliest = roundUpTo15Min(now);
      windows = windows
        .map(w => ({ start: w.start < earliest ? earliest : w.start, end: w.end }))
        .filter(w => w.start < w.end);
    }

    if (day.toDateString() === deadline.toDateString()) {
      windows = windows
        .map(w => ({ start: w.start, end: w.end > deadline ? deadline : w.end }))
        .filter(w => w.start < w.end);
    }

    return windows;
  }

  function getEventsForDay(day: Date) {
    return existingEvents.filter((evt) => {
      if (excludeEventIds?.includes(evt.id)) return false;
      const evtStart = new Date(evt.startTime);
      const evtEnd = evt.endTime ? new Date(evt.endTime) : new Date(evtStart.getTime() + 30 * 60000);
      return evtStart.toDateString() === day.toDateString() ||
             evtEnd.toDateString() === day.toDateString();
    });
  }

  function hasConflict(slotStart: Date, slotEnd: Date, dayEvents: ExistingEvent[]): boolean {
    return dayEvents.some((evt) => {
      const evtStart = new Date(evt.startTime);
      const evtEnd = evt.endTime ? new Date(evt.endTime) : new Date(evtStart.getTime() + 30 * 60000);
      return slotStart < evtEnd && slotEnd > evtStart;
    });
  }

  // Resolve direction
  const effectiveDirection: 'forward' | 'backward' =
    direction === 'forward' ? 'forward'
    : direction === 'backward' ? 'backward'
    : weight <= 1 ? 'backward'
    : 'forward';

  if (effectiveDirection === 'backward') {
    const currentDay = new Date(searchEnd);
    currentDay.setHours(0, 0, 0, 0);

    const searchStart = new Date(now);
    searchStart.setHours(0, 0, 0, 0);

    while (currentDay >= searchStart) {
      const windows = getWindowsForDay(currentDay);
      const dayEvents = getEventsForDay(currentDay);

      for (let wi = windows.length - 1; wi >= 0; wi--) {
        const window = windows[wi];
        if (!window) continue;
        let slotStart = new Date(window.end.getTime() - durationMs);

        while (slotStart >= window.start) {
          const slotEnd = new Date(slotStart.getTime() + durationMs);

          if (!hasConflict(slotStart, slotEnd, dayEvents)) {
            return { startTime: slotStart, endTime: slotEnd };
          }

          slotStart = new Date(slotStart.getTime() - SLOT_STEP_MINUTES * 60000);
        }
      }

      currentDay.setDate(currentDay.getDate() - 1);
    }

    return null;
  }

  // Forward search
  const currentDay = new Date(now);
  currentDay.setHours(0, 0, 0, 0);

  while (currentDay <= searchEnd) {
    const windows = getWindowsForDay(currentDay);
    const dayEvents = getEventsForDay(currentDay);

    for (const window of windows) {
      let slotStart = new Date(window.start);

      while (slotStart.getTime() + durationMs <= window.end.getTime()) {
        const slotEnd = new Date(slotStart.getTime() + durationMs);

        if (!hasConflict(slotStart, slotEnd, dayEvents)) {
          return { startTime: slotStart, endTime: slotEnd };
        }

        slotStart = new Date(slotStart.getTime() + SLOT_STEP_MINUTES * 60000);
      }
    }

    currentDay.setDate(currentDay.getDate() + 1);
  }

  return null;
}

// ── Cascading bump: find lower-priority event we can displace ───────────

interface BumpCandidate {
  eventId: string;
  sourceId: string | null;
  startTime: Date;
  endTime: Date;
  priority: string | null;
  organizerId: string;
}

async function findBumpableEvent(
  db: Database,
  params: {
    userId: string;
    deadline: Date;
    incomingPriorityWeight: number;
    durationMinutes: number;
    visitedEventIds: Set<string>;
    earliestStart?: Date;
  },
): Promise<BumpCandidate | null> {
  const { calendarEvents } = schema;
  const durationMs = params.durationMinutes * 60000;

  const start = params.earliestStart ?? new Date();
  const dayStart = new Date(start);
  dayStart.setHours(0, 0, 0, 0);

  const searchEnd = new Date(params.deadline);
  const dayEnd = new Date(searchEnd);
  dayEnd.setHours(23, 59, 59, 999);

  // Only auto-scheduled events are eligible for displacement.
  // Events where autoScheduled=false have been manually pinned by the user
  // (via drag-to-pin / the PATCH /reschedule endpoint with manual=true) and
  // must never be moved by the cascading-bump algorithm.
  const candidates = await db
    .select({
      id: calendarEvents.id,
      startTime: calendarEvents.startTime,
      endTime: calendarEvents.endTime,
      priority: calendarEvents.priority,
      sourceId: calendarEvents.sourceId,
      autoScheduled: calendarEvents.autoScheduled,
      organizerId: calendarEvents.organizerId,
    })
    .from(calendarEvents)
    .where(and(
      isNull(calendarEvents.deletedAt),
      eq(calendarEvents.organizerId, params.userId),
      eq(calendarEvents.status, 'confirmed'),
      eq(calendarEvents.autoScheduled, true),  // pinned events (autoScheduled=false) are NEVER displaced
      gte(calendarEvents.startTime, dayStart),
      lte(calendarEvents.startTime, dayEnd),
    ));

  const bumpable = candidates
    .filter((evt) => {
      if (params.visitedEventIds.has(evt.id)) return false;
      const evtWeight = priorityWeight(evt.priority);
      if (evtWeight >= params.incomingPriorityWeight) return false;
      const evtStart = new Date(evt.startTime);
      const evtEnd = evt.endTime ? new Date(evt.endTime) : new Date(evtStart.getTime() + 30 * 60000);
      return (evtEnd.getTime() - evtStart.getTime()) >= durationMs;
    })
    .map((evt) => ({
      eventId: evt.id,
      sourceId: evt.sourceId,
      startTime: new Date(evt.startTime),
      endTime: evt.endTime ? new Date(evt.endTime) : new Date(new Date(evt.startTime).getTime() + 30 * 60000),
      priority: evt.priority,
      organizerId: evt.organizerId,
      weight: priorityWeight(evt.priority),
    }))
    .sort((a, b) => a.weight - b.weight || a.startTime.getTime() - b.startTime.getTime());

  return bumpable[0] ?? null;
}

/**
 * Reschedule a bumped event to a new slot. May trigger another bump if no
 * free slot is available and the bumped event itself outranks something.
 * Depth-limited and cycle-protected.
 */
async function rescheduleBumpedEvent(
  db: Database,
  candidate: BumpCandidate,
  ctx: SchedulingContext,
  visitedEventIds: Set<string>,
  depth: number,
): Promise<void> {
  const { calendarEvents, tasks } = schema;

  // Look up the source task to get its deadline (if any) and duration
  let taskDueDate: Date | null = null;
  let taskDuration: number | null = null;

  if (candidate.sourceId) {
    const [task] = await db
      .select({
        dueDate: tasks.dueDate,
        duration: tasks.duration,
      })
      .from(tasks)
      .where(eq(tasks.id, candidate.sourceId))
      .limit(1);

    if (task) {
      taskDueDate = task.dueDate ? new Date(task.dueDate) : null;
      taskDuration = task.duration ?? null;
    }
  }

  const duration = taskDuration ?? Math.max(
    DEFAULT_DURATION_MINUTES,
    Math.round((candidate.endTime.getTime() - candidate.startTime.getTime()) / 60000),
  );

  // Cap the search:
  // - real dueDate → never past it
  // - no dueDate → 60-day window (extended to 90 if first pass fails)
  const now = new Date();
  const noDeadlineCap = new Date(now.getTime() + MAX_SEARCH_DAYS_NO_DEADLINE * 24 * 60 * 60 * 1000);
  const noDeadlineCapExtended = new Date(now.getTime() + MAX_SEARCH_DAYS_NO_DEADLINE_EXTENDED * 24 * 60 * 60 * 1000);
  const primaryDeadline = taskDueDate ?? noDeadlineCap;

  // Try forward-direction free slot first (excluding our own event so it doesn't conflict with itself)
  let slot = await findFreeSlot(db, {
    userId: candidate.organizerId,
    deadline: primaryDeadline,
    durationMinutes: duration,
    timezone: ctx.timezone,
    workingHours: ctx.workingHours,
    priority: candidate.priority ?? undefined,
    excludeEventIds: [candidate.eventId, ...Array.from(visitedEventIds)],
    direction: taskDueDate ? 'auto' : 'forward',
  });

  // No-dueDate: try the extended 90-day window before bumping
  if (!slot && !taskDueDate) {
    slot = await findFreeSlot(db, {
      userId: candidate.organizerId,
      deadline: noDeadlineCapExtended,
      durationMinutes: duration,
      timezone: ctx.timezone,
      workingHours: ctx.workingHours,
      priority: candidate.priority ?? undefined,
      excludeEventIds: [candidate.eventId, ...Array.from(visitedEventIds)],
      direction: 'forward',
    });
  }

  if (slot) {
    await db.update(calendarEvents)
      .set({
        startTime: slot.startTime,
        endTime: slot.endTime,
        allDay: false,
        updatedAt: new Date(),
      })
      .where(and(eq(calendarEvents.id, candidate.eventId), isNull(calendarEvents.deletedAt)));
    return;
  }

  // No free slot. Try to cascade-bump someone of even lower priority if we can.
  const candidateWeight = priorityWeight(candidate.priority);
  if (depth < MAX_CASCADE_DEPTH && candidateWeight > 0) {
    const sub = await findBumpableEvent(db, {
      userId: candidate.organizerId,
      deadline: primaryDeadline,
      incomingPriorityWeight: candidateWeight,
      durationMinutes: duration,
      visitedEventIds,
    });

    if (sub) {
      // Take sub's slot; recursively re-place sub
      const newStart = sub.startTime;
      const newEnd = new Date(sub.startTime.getTime() + duration * 60000);

      await db.update(calendarEvents)
        .set({
          startTime: newStart,
          endTime: newEnd,
          allDay: false,
          updatedAt: new Date(),
        })
        .where(and(eq(calendarEvents.id, candidate.eventId), isNull(calendarEvents.deletedAt)));

      const nextVisited = new Set(visitedEventIds);
      nextVisited.add(candidate.eventId);
      await rescheduleBumpedEvent(db, sub, ctx, nextVisited, depth + 1);
      return;
    }
  }

  // Last resort:
  if (taskDueDate) {
    // All-day on the deadline
    const fallbackDate = new Date(taskDueDate);
    fallbackDate.setHours(0, 0, 0, 0);
    await db.update(calendarEvents)
      .set({
        startTime: fallbackDate,
        endTime: null,
        allDay: true,
        updatedAt: new Date(),
      })
      .where(and(eq(calendarEvents.id, candidate.eventId), isNull(calendarEvents.deletedAt)));
  } else {
    // No-dueDate event with absolutely no slot available — park at the far edge
    // of the 60-day window as an all-day event so it stays visible, and warn.
    const fallbackDate = new Date(noDeadlineCap);
    fallbackDate.setHours(0, 0, 0, 0);
    await db.update(calendarEvents)
      .set({
        startTime: fallbackDate,
        endTime: null,
        allDay: true,
        updatedAt: new Date(),
      })
      .where(and(eq(calendarEvents.id, candidate.eventId), isNull(calendarEvents.deletedAt)));
    console.warn('[calendar-sync] No slot found within 90 days for bumped event', candidate.eventId);
  }
}

// ── Create calendar event for a task (with auto-scheduling) ─────────────

interface CreateEventParams {
  userId: string;
  /**
   * The ID of the source entity (task, activity, etc.).
   * @deprecated Use `sourceId` instead. Kept for backward compat — if both are
   * provided, `sourceId` takes precedence.
   */
  taskId?: string;
  /** ID of the source entity. Defaults to `taskId` when omitted. */
  sourceId?: string;
  /**
   * The type of entity that owns this calendar event.
   * Defaults to 'task' for backward compat.
   * The `calendarEvents.source_type` column is varchar(20) — any value ≤ 20 chars is valid.
   */
  sourceType?: string;
  title: string;
  description?: string | null;
  /** If null/undefined, the event is placed forward from now within a 60-day window. */
  dueDate?: Date | null;
  /** If set, the event is pinned to this start (no auto-placement). */
  startDate?: Date | null;
  durationMinutes?: number | null;
  priority?: string | null;
}

export async function createCalendarEventForTask(
  db: Database,
  params: CreateEventParams,
): Promise<string> {
  const { calendarEvents } = schema;
  const calendarId = await ensureDefaultCalendar(db, params.userId);
  const id = generateId('evt');
  const now = new Date();
  const duration = params.durationMinutes || DEFAULT_DURATION_MINUTES;
  const calPriority = taskPriorityToCalendarPriority(params.priority);
  const weight = priorityWeight(params.priority);

  // Resolve source fields — support both old taskId and new sourceId/sourceType API.
  const resolvedSourceId = params.sourceId ?? params.taskId;
  const resolvedSourceType = params.sourceType ?? 'task';

  // User-pinned (explicit startDate) — respect it, no auto-placement.
  if (params.startDate) {
    const endTime = params.dueDate ?? new Date(params.startDate.getTime() + duration * 60000);
    await db.insert(calendarEvents).values({
      id,
      calendarId,
      title: params.title,
      description: params.description || null,
      type: 'reminder',
      startTime: params.startDate,
      endTime,
      allDay: false,
      status: 'confirmed',
      priority: calPriority,
      organizerId: params.userId,
      sourceType: resolvedSourceType,
      sourceId: resolvedSourceId,
      autoScheduled: false,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  const ctx = await getUserSchedulingContext(db, params.userId);
  const hasDueDate = !!params.dueDate;

  let schedulingDeadline: Date;
  let direction: SearchDirection;

  if (hasDueDate) {
    // Real-deadline path: keep historical behaviour.
    schedulingDeadline = params.dueDate as Date;
    if (schedulingDeadline <= now && (now.getTime() - schedulingDeadline.getTime()) < 24 * 60 * 60 * 1000) {
      // Timezone edge case: "today" might be just past midnight UTC even though
      // it's still today in the user's tz. Extend to end of today so we can
      // still place the event in remaining working hours.
      const endOfToday = new Date(now);
      endOfToday.setHours(23, 59, 59, 999);
      schedulingDeadline = endOfToday;
    }
    direction = 'auto';
  } else {
    // No-deadline path: 60-day forward window.
    schedulingDeadline = new Date(now.getTime() + MAX_SEARCH_DAYS_NO_DEADLINE * 24 * 60 * 60 * 1000);
    direction = 'forward';
  }

  let slot = await findFreeSlot(db, {
    userId: params.userId,
    deadline: schedulingDeadline,
    durationMinutes: duration,
    timezone: ctx.timezone,
    workingHours: ctx.workingHours,
    priority: params.priority || undefined,
    direction,
  });

  // No-dueDate: try the extended 90-day window before bumping
  if (!slot && !hasDueDate) {
    schedulingDeadline = new Date(now.getTime() + MAX_SEARCH_DAYS_NO_DEADLINE_EXTENDED * 24 * 60 * 60 * 1000);
    slot = await findFreeSlot(db, {
      userId: params.userId,
      deadline: schedulingDeadline,
      durationMinutes: duration,
      timezone: ctx.timezone,
      workingHours: ctx.workingHours,
      priority: params.priority || undefined,
      direction: 'forward',
    });
  }

  if (slot) {
    await db.insert(calendarEvents).values({
      id,
      calendarId,
      title: params.title,
      description: params.description || null,
      type: 'reminder',
      startTime: slot.startTime,
      endTime: slot.endTime,
      allDay: false,
      status: 'confirmed',
      priority: calPriority,
      organizerId: params.userId,
      sourceType: resolvedSourceType,
      sourceId: resolvedSourceId,
      autoScheduled: true,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  // No free slot — try cascading bumps for medium+ priority tasks
  if (weight >= 2) {
    const visited = new Set<string>();
    const candidate = await findBumpableEvent(db, {
      userId: params.userId,
      deadline: schedulingDeadline,
      incomingPriorityWeight: weight,
      durationMinutes: duration,
      visitedEventIds: visited,
    });

    if (candidate) {
      const durationMs = duration * 60000;
      await db.insert(calendarEvents).values({
        id,
        calendarId,
        title: params.title,
        description: params.description || null,
        type: 'reminder',
        startTime: candidate.startTime,
        endTime: new Date(candidate.startTime.getTime() + durationMs),
        allDay: false,
        status: 'confirmed',
        priority: calPriority,
        organizerId: params.userId,
        sourceType: resolvedSourceType,
        sourceId: resolvedSourceId,
        autoScheduled: true,
        createdAt: now,
        updatedAt: now,
      });

      const nextVisited = new Set([id]);
      await rescheduleBumpedEvent(db, candidate, ctx, nextVisited, 1);

      return id;
    }
  }

  // Final fallback:
  // - With dueDate: all-day on the deadline (legacy behaviour)
  // - Without dueDate: all-day at the far edge of the 60-day window
  const fallbackBase = hasDueDate
    ? schedulingDeadline
    : new Date(now.getTime() + MAX_SEARCH_DAYS_NO_DEADLINE * 24 * 60 * 60 * 1000);
  const fallbackDate = new Date(fallbackBase);
  fallbackDate.setHours(0, 0, 0, 0);

  await db.insert(calendarEvents).values({
    id,
    calendarId,
    title: params.title,
    description: params.description || null,
    type: 'reminder',
    startTime: fallbackDate,
    endTime: null,
    allDay: true,
    status: 'confirmed',
    priority: calPriority,
    organizerId: params.userId,
    sourceType: resolvedSourceType,
    sourceId: resolvedSourceId,
    autoScheduled: hasDueDate ? false : true,
    createdAt: now,
    updatedAt: now,
  });

  if (!hasDueDate) {
    console.warn('[calendar-sync] No slot found within 90 days for new no-dueDate event', id);
  }

  return id;
}

// ── Update calendar event for a task ────────────────────────────────────

interface UpdateEventParams {
  calendarEventId: string;
  title?: string;
  dueDate?: Date | null;
  startDate?: Date | null;
}

export async function updateCalendarEventForTask(
  db: Database,
  params: UpdateEventParams,
): Promise<void> {
  const { calendarEvents } = schema;

  const updateData: Record<string, any> = { updatedAt: new Date() };

  if (params.title !== undefined) {
    updateData.title = params.title;
  }
  if (params.dueDate !== undefined) {
    if (params.startDate !== undefined && params.startDate) {
      updateData.startTime = params.startDate;
      updateData.endTime = params.dueDate;
    } else if (params.dueDate) {
      updateData.startTime = params.dueDate;
    }
  } else if (params.startDate !== undefined) {
    updateData.startTime = params.startDate;
  }

  await db
    .update(calendarEvents)
    .set(updateData)
    .where(
      and(
        eq(calendarEvents.id, params.calendarEventId),
        isNull(calendarEvents.deletedAt),
      )
    );
}

// ── Reschedule: delete old event, find new slot, create new ─────────────

interface RescheduleParams {
  calendarEventId: string;
  userId: string;
  /**
   * The ID of the source entity (task ID, activity ID, etc.).
   * @deprecated Use `sourceId` instead. Kept for backward compat.
   */
  taskId?: string;
  /** ID of the source entity. Defaults to `taskId` when omitted. */
  sourceId?: string;
  /** Defaults to 'task' for backward compat. */
  sourceType?: string;
  title: string;
  description?: string | null;
  /** May be null — reschedules into the no-dueDate window. */
  dueDate?: Date | null;
  startDate?: Date | null;
  durationMinutes?: number | null;
  priority?: string | null;
}

export async function rescheduleCalendarEvent(
  db: Database,
  params: RescheduleParams,
): Promise<string> {
  const { calendarEvents } = schema;

  // Pinned events (autoScheduled=false) reflect a user's explicit choice of
  // time — priority/dueDate changes must not displace them. Just update the
  // display fields (title/description) and adjust endTime if duration changed.
  // The pinned startTime is preserved; the user can unpin to re-enable
  // auto-scheduling.
  const [existing] = await db
    .select({
      id: calendarEvents.id,
      autoScheduled: calendarEvents.autoScheduled,
      startTime: calendarEvents.startTime,
    })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.id, params.calendarEventId),
        isNull(calendarEvents.deletedAt),
      ),
    )
    .limit(1);

  if (existing && existing.autoScheduled === false) {
    const update: Record<string, any> = {
      updatedAt: new Date(),
      title: params.title,
      description: params.description ?? null,
    };
    if (params.durationMinutes && existing.startTime) {
      update.endTime = new Date(
        new Date(existing.startTime as Date).getTime() + params.durationMinutes * 60_000,
      );
    }
    await db
      .update(calendarEvents)
      .set(update)
      .where(eq(calendarEvents.id, params.calendarEventId));
    return params.calendarEventId;
  }

  // Auto-scheduled (or legacy null): delete the old event and re-run
  // findFreeSlot with the new params so priority/dueDate take effect.
  await deleteCalendarEvent(db, params.calendarEventId);

  return createCalendarEventForTask(db, {
    userId: params.userId,
    taskId: params.taskId,
    sourceId: params.sourceId,
    sourceType: params.sourceType,
    title: params.title,
    description: params.description,
    dueDate: params.dueDate ?? null,
    startDate: params.startDate ?? null,
    durationMinutes: params.durationMinutes,
    priority: params.priority,
  });
}

// ── Cancel calendar event (task completed) ──────────────────────────────

export async function cancelCalendarEvent(db: Database, calendarEventId: string): Promise<void> {
  const { calendarEvents } = schema;

  await db
    .update(calendarEvents)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(
      and(
        eq(calendarEvents.id, calendarEventId),
        isNull(calendarEvents.deletedAt),
      )
    );
}

// ── Re-confirm calendar event (task uncompleted) ────────────────────────

export async function confirmCalendarEvent(db: Database, calendarEventId: string): Promise<void> {
  const { calendarEvents } = schema;

  await db
    .update(calendarEvents)
    .set({ status: 'confirmed', updatedAt: new Date() })
    .where(
      and(
        eq(calendarEvents.id, calendarEventId),
        isNull(calendarEvents.deletedAt),
      )
    );
}

// ── Soft-delete calendar event (task deleted) ───────────────────────────

export async function deleteCalendarEvent(db: Database, calendarEventId: string): Promise<void> {
  const { calendarEvents } = schema;
  const now = new Date();

  await db
    .update(calendarEvents)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(calendarEvents.id, calendarEventId),
        isNull(calendarEvents.deletedAt),
      )
    );
}

// ── Nightly re-plan: catch up stale auto-scheduled events ───────────────

/**
 * Walk all auto-scheduled calendar events whose startTime has slipped into
 * the past while their source task is still incomplete. Reschedule each so
 * the calendar reflects "what's coming up", not "what should have happened".
 *
 * Intended to be invoked from a daily cron handler (one DB at a time).
 */
export async function replanStaleAutoScheduledEvents(
  db: Database,
  options: { batchLimit?: number } = {},
): Promise<{ scanned: number; rescheduled: number; failed: number }> {
  const { calendarEvents, tasks } = schema;
  const limit = options.batchLimit ?? 200;
  const now = new Date();

  const stale = await db
    .select({
      eventId: calendarEvents.id,
      organizerId: calendarEvents.organizerId,
      title: calendarEvents.title,
      description: calendarEvents.description,
      taskId: tasks.id,
      taskTitle: tasks.title,
      taskDescription: tasks.description,
      taskDueDate: tasks.dueDate,
      taskStartDate: tasks.startDate,
      taskDuration: tasks.duration,
      taskPriority: tasks.priority,
      taskStatus: tasks.status,
      taskCreatedAt: tasks.createdAt,
    })
    .from(calendarEvents)
    .innerJoin(tasks, eq(calendarEvents.sourceId, tasks.id))
    .where(and(
      isNull(calendarEvents.deletedAt),
      eq(calendarEvents.autoScheduled, true),
      eq(calendarEvents.status, 'confirmed'),
      lte(calendarEvents.startTime, now),
      isNull(tasks.deletedAt),
    ))
    // DB-level sort: highest priority first, then earliest due date, then oldest task.
    // Mirrors the in-memory sort below so pagination respects the same order.
    .orderBy(
      sql`CASE tasks.priority
        WHEN 'critical' THEN 4
        WHEN 'urgent' THEN 4
        WHEN 'high' THEN 3
        WHEN 'medium' THEN 2
        WHEN 'normal' THEN 2
        WHEN 'low' THEN 1
        ELSE 0
      END DESC`,
      sql`tasks.due_date ASC NULLS LAST`,
      sql`tasks.created_at ASC`,
    )
    .limit(limit);

  const result = { scanned: stale.length, rescheduled: 0, failed: 0 };

  // Stable in-memory sort mirrors the SQL ORDER BY above so that tasks processed
  // within the batch are always handled in priority DESC → dueDate ASC → createdAt ASC order,
  // even if DB pagination shifts slightly between runs.
  const ordered = stale.slice().sort((a, b) => {
    const weightDiff = priorityWeight(b.taskPriority) - priorityWeight(a.taskPriority);
    if (weightDiff !== 0) return weightDiff;
    // dueDate ASC — nulls last
    const aDate = a.taskDueDate ? new Date(a.taskDueDate).getTime() : Infinity;
    const bDate = b.taskDueDate ? new Date(b.taskDueDate).getTime() : Infinity;
    if (aDate !== bDate) return aDate - bDate;
    // createdAt ASC
    return new Date(a.taskCreatedAt).getTime() - new Date(b.taskCreatedAt).getTime();
  });

  for (const row of ordered) {
    if (row.taskStatus === 'done' || row.taskStatus === 'cancelled') continue;

    try {
      const newEventId = await rescheduleCalendarEvent(db, {
        calendarEventId: row.eventId,
        userId: row.organizerId as string,
        taskId: row.taskId as string,
        title: row.taskTitle as string,
        description: (row.taskDescription as string) || null,
        dueDate: row.taskDueDate ? new Date(row.taskDueDate) : null,
        startDate: row.taskStartDate ? new Date(row.taskStartDate) : null,
        durationMinutes: (row.taskDuration as number | null) ?? null,
        priority: (row.taskPriority as string | null) ?? null,
      });

      await db.update(tasks).set({ calendarEventId: newEventId }).where(eq(tasks.id, row.taskId as string));
      result.rescheduled++;
    } catch (err) {
      result.failed++;
      console.error('[calendar-sync] replan failed for event', row.eventId, err);
    }
  }

  return result;
}

/**
 * Look up the currently-scheduled calendar slot for a batch of task IDs.
 * Returns a Map keyed by taskId so list/get endpoints can attach scheduling
 * info to task responses without a per-task round-trip.
 */
export async function fetchTaskScheduledSlots(
  db: Database,
  taskIds: string[],
): Promise<Map<string, { eventId: string; startTime: Date; endTime: Date; autoScheduled: boolean }>> {
  const map = new Map<string, { eventId: string; startTime: Date; endTime: Date; autoScheduled: boolean }>();
  if (!taskIds || taskIds.length === 0) return map;

  const { calendarEvents } = schema;
  const rows = await db
    .select({
      id: calendarEvents.id,
      sourceId: calendarEvents.sourceId,
      startTime: calendarEvents.startTime,
      endTime: calendarEvents.endTime,
      autoScheduled: calendarEvents.autoScheduled,
      status: calendarEvents.status,
    })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.sourceType, 'task'),
        inArray(calendarEvents.sourceId, taskIds),
        isNull(calendarEvents.deletedAt),
      ),
    );

  for (const row of rows) {
    if (row.status === 'cancelled') continue;
    if (!row.sourceId) continue;
    map.set(row.sourceId as string, {
      eventId: row.id as string,
      startTime: row.startTime as Date,
      endTime: row.endTime as Date,
      autoScheduled: !!row.autoScheduled,
    });
  }

  return map;
}
