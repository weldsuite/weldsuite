/**
 * Capacity routes: /api/capacity/*, backed by `resource_bookings`,
 * `resource_requests` and `flow_member_profiles` (design:
 * weldflow-delivery-and-portfolio.md, "Capacity").
 *
 *   GET    /                         load per member and ISO week (?from&to&skill&tentative)
 *   GET    /bookings                 list (memberId, projectId, requestId, from, to, cursor)
 *   POST   /bookings                 book a member on a project, or tentatively for a request
 *   PATCH  /bookings/:id             change the period, the hours or tentative
 *   DELETE /bookings/:id             soft delete; a request booked by it opens again
 *   GET    /requests                 resource requests (projectId, status, cursor)
 *   POST   /requests                 a project asks for a skill, hours per week, a period
 *   PATCH  /requests/:id             edit or cancel an open request
 *   DELETE /requests/:id             soft delete
 *   GET    /requests/:id/suggestions people with the skill, by free hours
 *   POST   /requests/:id/book        book a member on it (firm or tentative)
 *   GET    /profiles                 every member profile
 *   GET    /profiles/:memberId       one profile (defaults when there is none)
 *   PUT    /profiles/:memberId       weekly hours and skills (portfolio:manage, or your own)
 *
 * Capacity is workspace-level: reading it needs `portfolio:read`, changing it
 * `portfolio:manage`. A project manager may also book people on, and ask for
 * people for, their own project, and a member may book themselves on a project
 * they can write to. Project names come back only for projects the caller is
 * a member of ("Other project" otherwise), and task titles never do. The
 * checks run in a fixed order so every backend answers alike: permission, then
 * the row (404), then access (403), then the body (400), then the rules.
 */

import { Hono } from 'hono';
import { and, asc, desc, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import {
  bookResourceRequestSchema,
  capacityQuerySchema,
  createBookingSchema,
  createResourceRequestSchema,
  listBookingsQuerySchema,
  listResourceRequestsQuerySchema,
  updateBookingSchema,
  updateMemberProfileSchema,
  updateResourceRequestSchema,
} from '@weldsuite/app-api-client/schemas/flow-portfolio';
import {
  CAPACITY_MESSAGES,
  bookingTargetError,
  capacityRange,
  fitRange,
  normalizeSkills,
  periodError,
  presentBooking,
  presentProfile,
  presentResourceRequest,
  resourceRequestEventData,
  round2,
  suggestMembers,
} from '@weldsuite/flow-domain/capacity';
import type { Env, Variables } from '../../types';
import { canManageProject, canWriteProject } from '../../lib/project-access';
import { parseLimit } from '../../lib/query-params';
import { flag, parseBody, readQuery, todayUtc, type PortfolioContext } from '../../lib/portfolio-request';
import {
  findBooking,
  findProfile,
  findResourceRequest,
  hours2,
  labelOf,
  liveProjectExists,
  loadCapacity,
  presentLoad,
  projectLabels,
  type BookingRow,
  type ResourceRequestRow,
} from '../../services/capacity';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const bookings = schema.resourceBookings;
const requests = schema.resourceRequests;
const profiles = schema.flowMemberProfiles;
const projectRequests = schema.projectRequests;

const BOOKING_LABEL = 'Booking';
const REQUEST_LABEL = 'Resource request';

type Ctx = PortfolioContext;

// ── Access ──────────────────────────────────────────────────────────────────

const canManagePortfolio = (c: Ctx) => hasContextPermission(c, 'portfolio:manage');

/**
 * May the caller book this person on this target? `portfolio:manage` books
 * anyone anywhere. Otherwise a manager of the project books on it, and a
 * member who can write to a project books themselves on it.
 */
async function mayBook(c: Ctx, target: { memberId: string; projectId: string | null }): Promise<boolean> {
  if (await canManagePortfolio(c)) return true;
  if (!target.projectId) return false;
  if (await canManageProject(c, target.projectId)) return true;
  return target.memberId === c.get('userId') && (await canWriteProject(c, target.projectId));
}

/** May the caller ask for people for this project? `portfolio:manage`, or a manager of the project. */
async function mayRequestFor(c: Ctx, projectId: string): Promise<boolean> {
  return (await canManagePortfolio(c)) || (await canManageProject(c, projectId));
}

// ── Events ──────────────────────────────────────────────────────────────────

function publishBooking(c: Ctx, action: 'created' | 'updated' | 'deleted', row: BookingRow) {
  publishEntityEvent({
    c,
    entityType: 'resource_booking',
    entityId: row.id,
    action,
    data: { ...presentBooking(row) },
  });
}

function publishResourceRequest(c: Ctx, action: 'created' | 'updated' | 'deleted', row: ResourceRequestRow) {
  publishEntityEvent({
    c,
    entityType: 'resource_request',
    entityId: row.id,
    action,
    data: resourceRequestEventData(row),
  });
}

/** The open, bookable state of a request a booking is held for: not yet decided. */
const HELD_REQUEST_STATUSES = ['new', 'assessing', 'approved'];

// ── Load ────────────────────────────────────────────────────────────────────

app.get('/', requirePermission('portfolio:read'), async (c) => {
  const query = readQuery(c, capacityQuerySchema);
  if (!query.ok) return query.response;
  const q = query.data;
  const range = capacityRange(q.from, q.to, todayUtc());
  if ('error' in range) return error.badRequest(c, range.error);
  const includeTentative = flag(q.tentative);
  try {
    const load = await loadCapacity(c.get('tenantDb'), range, { includeTentative, skill: q.skill });
    return success(c, await presentLoad(c, load, range, includeTentative));
  } catch (err) {
    console.error('[flow-api/capacity] load failed:', err);
    return error.internal(c, 'Failed to load capacity');
  }
});

// ── Bookings ────────────────────────────────────────────────────────────────

app.get('/bookings', requirePermission('portfolio:read'), async (c) => {
  const db = c.get('tenantDb');
  const query = readQuery(c, listBookingsQuerySchema);
  if (!query.ok) return query.response;
  const q = query.data;
  const limit = parseLimit(q.limit, 50, 200);
  const conditions: SQL[] = [isNull(bookings.deletedAt)];
  if (q.memberId) conditions.push(eq(bookings.memberId, q.memberId));
  if (q.projectId) conditions.push(eq(bookings.projectId, q.projectId));
  if (q.requestId) conditions.push(eq(bookings.requestId, q.requestId));
  // A period overlaps [from, to] when it starts by `to` and ends no earlier than `from`.
  if (q.to) conditions.push(lte(bookings.startsOn, q.to));
  if (q.from) conditions.push(gte(bookings.endsOn, q.from));
  const countWhere = and(...conditions);
  if (q.cursor) {
    const [cur] = await db.select({ createdAt: bookings.createdAt, id: bookings.id }).from(bookings).where(eq(bookings.id, q.cursor)).limit(1);
    if (cur) {
      conditions.push(
        sql`(${bookings.createdAt} < ${cur.createdAt} OR (${bookings.createdAt} = ${cur.createdAt} AND ${bookings.id} < ${cur.id}))`,
      );
    }
  }
  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(bookings).where(and(...conditions)).orderBy(desc(bookings.createdAt), desc(bookings.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(bookings).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    return list(c, data.map(presentBooking), cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor));
  } catch (err) {
    console.error('[flow-api/capacity] list bookings failed:', err);
    return error.internal(c, 'Failed to list bookings');
  }
});

app.post('/bookings', requirePermission('portfolio:manage', 'projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, createBookingSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  const targetError = bookingTargetError(input);
  if (targetError) return error.badRequest(c, targetError);
  const dateError = periodError(input.startsOn, input.endsOn);
  if (dateError) return error.badRequest(c, dateError);
  const tentative = input.tentative ?? false;
  if (input.requestId && !tentative) return error.badRequest(c, CAPACITY_MESSAGES.heldBookingTentative);

  if (!(await mayBook(c, { memberId: input.memberId, projectId: input.projectId ?? null }))) {
    return error.forbidden(c, CAPACITY_MESSAGES.bookingForbidden);
  }
  if (input.projectId && !(await liveProjectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);
  if (input.requestId) {
    const [request] = await db
      .select({ id: projectRequests.id, status: projectRequests.status })
      .from(projectRequests)
      .where(and(eq(projectRequests.id, input.requestId), isNull(projectRequests.deletedAt)))
      .limit(1);
    if (!request) return error.notFound(c, 'Project request', input.requestId);
    if (!HELD_REQUEST_STATUSES.includes(request.status)) return error.conflict(c, CAPACITY_MESSAGES.heldRequestClosed);
  }

  try {
    const now = new Date();
    const id = generateId('bkg');
    await atomically(db, (handle) => [
      handle.insert(bookings).values({
        id,
        memberId: input.memberId,
        projectId: input.projectId ?? null,
        requestId: input.requestId ?? null,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        hoursPerWeek: hours2(input.hoursPerWeek),
        tentative,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      }),
    ]);
    const row = await findBooking(db, id);
    if (!row) return error.internal(c, 'Failed to create booking');
    publishBooking(c, 'created', row);
    return success(c, presentBooking(row), 201);
  } catch (err) {
    console.error('[flow-api/capacity] create booking failed:', err);
    return error.internal(c, 'Failed to create booking');
  }
});

app.patch('/bookings/:id', requirePermission('portfolio:manage', 'projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findBooking(db, id);
  if (!existing) return error.notFound(c, BOOKING_LABEL, id);
  if (!(await mayBook(c, existing))) return error.forbidden(c, CAPACITY_MESSAGES.bookingForbidden);
  const body = await parseBody(c, updateBookingSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  const startsOn = input.startsOn ?? existing.startsOn;
  const endsOn = input.endsOn ?? existing.endsOn;
  const dateError = periodError(startsOn, endsOn);
  if (dateError) return error.badRequest(c, dateError);
  const tentative = input.tentative ?? existing.tentative;
  if (existing.requestId && !tentative) return error.badRequest(c, CAPACITY_MESSAGES.heldBookingTentative);

  try {
    const now = new Date();
    await atomically(db, (handle) => [
      handle
        .update(bookings)
        .set({
          startsOn,
          endsOn,
          hoursPerWeek: input.hoursPerWeek === undefined ? existing.hoursPerWeek : hours2(input.hoursPerWeek),
          tentative,
          updatedAt: now,
        })
        .where(and(eq(bookings.id, id), isNull(bookings.deletedAt))),
    ]);
    const row = await findBooking(db, id);
    if (!row) return error.notFound(c, BOOKING_LABEL, id);
    publishBooking(c, 'updated', row);
    return success(c, presentBooking(row));
  } catch (err) {
    console.error('[flow-api/capacity] update booking failed:', err);
    return error.internal(c, 'Failed to update booking');
  }
});

app.delete('/bookings/:id', requirePermission('portfolio:manage', 'projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findBooking(db, id);
  if (!existing) return error.notFound(c, BOOKING_LABEL, id);
  if (!(await mayBook(c, existing))) return error.forbidden(c, CAPACITY_MESSAGES.bookingForbidden);

  try {
    // The request this booking filled opens again, in the same batch.
    const reopened = await db
      .select()
      .from(requests)
      .where(and(eq(requests.bookingId, id), eq(requests.status, 'booked'), isNull(requests.deletedAt)));
    const now = new Date();
    await atomically(db, (handle) => [
      handle.update(bookings).set({ deletedAt: now, updatedAt: now }).where(and(eq(bookings.id, id), isNull(bookings.deletedAt))),
      handle
        .update(requests)
        .set({ status: 'open', bookingId: null, updatedAt: now })
        .where(and(eq(requests.bookingId, id), eq(requests.status, 'booked'), isNull(requests.deletedAt))),
    ]);
    publishBooking(c, 'deleted', existing);
    for (const request of reopened) {
      const row = await findResourceRequest(db, request.id);
      if (row) publishResourceRequest(c, 'updated', row);
    }
    return noContent(c);
  } catch (err) {
    console.error('[flow-api/capacity] delete booking failed:', err);
    return error.internal(c, 'Failed to delete booking');
  }
});

// ── Resource requests ───────────────────────────────────────────────────────

app.get('/requests', requirePermission('portfolio:read'), async (c) => {
  const db = c.get('tenantDb');
  const query = readQuery(c, listResourceRequestsQuerySchema);
  if (!query.ok) return query.response;
  const q = query.data;
  const limit = parseLimit(q.limit, 50, 200);
  const conditions: SQL[] = [isNull(requests.deletedAt)];
  if (q.projectId) conditions.push(eq(requests.projectId, q.projectId));
  if (q.status) conditions.push(eq(requests.status, q.status));
  const countWhere = and(...conditions);
  if (q.cursor) {
    const [cur] = await db.select({ createdAt: requests.createdAt, id: requests.id }).from(requests).where(eq(requests.id, q.cursor)).limit(1);
    if (cur) {
      conditions.push(
        sql`(${requests.createdAt} < ${cur.createdAt} OR (${requests.createdAt} = ${cur.createdAt} AND ${requests.id} < ${cur.id}))`,
      );
    }
  }
  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(requests).where(and(...conditions)).orderBy(desc(requests.createdAt), desc(requests.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(requests).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const labels = await projectLabels(c, data.map((row) => row.projectId));
    return list(
      c,
      data.map((row) => presentResourceRequest(row, labelOf(labels, row.projectId).name)),
      cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor),
    );
  } catch (err) {
    console.error('[flow-api/capacity] list requests failed:', err);
    return error.internal(c, 'Failed to list resource requests');
  }
});

/** The request as a route answers it: named for the caller. */
async function presentRequestFor(c: Ctx, row: ResourceRequestRow) {
  const labels = await projectLabels(c, [row.projectId]);
  return presentResourceRequest(row, labelOf(labels, row.projectId).name);
}

app.post('/requests', requirePermission('portfolio:manage', 'projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, createResourceRequestSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  const dateError = periodError(input.startsOn, input.endsOn);
  if (dateError) return error.badRequest(c, dateError);
  if (!(await mayRequestFor(c, input.projectId))) return error.forbidden(c, CAPACITY_MESSAGES.requestForbidden);
  if (!(await liveProjectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);

  try {
    const now = new Date();
    const id = generateId('rrq');
    await atomically(db, (handle) => [
      handle.insert(requests).values({
        id,
        projectId: input.projectId,
        skill: input.skill,
        hoursPerWeek: hours2(input.hoursPerWeek),
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        status: 'open',
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      }),
    ]);
    const row = await findResourceRequest(db, id);
    if (!row) return error.internal(c, 'Failed to create resource request');
    publishResourceRequest(c, 'created', row);
    return success(c, await presentRequestFor(c, row), 201);
  } catch (err) {
    console.error('[flow-api/capacity] create request failed:', err);
    return error.internal(c, 'Failed to create resource request');
  }
});

app.patch('/requests/:id', requirePermission('portfolio:manage', 'projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findResourceRequest(db, id);
  if (!existing) return error.notFound(c, REQUEST_LABEL, id);
  if (!(await mayRequestFor(c, existing.projectId))) return error.forbidden(c, CAPACITY_MESSAGES.requestForbidden);
  const body = await parseBody(c, updateResourceRequestSchema);
  if (!body.ok) return body.response;
  const input = body.data;
  if (existing.status !== 'open') return error.conflict(c, CAPACITY_MESSAGES.requestNotOpen);

  const startsOn = input.startsOn ?? existing.startsOn;
  const endsOn = input.endsOn ?? existing.endsOn;
  const dateError = periodError(startsOn, endsOn);
  if (dateError) return error.badRequest(c, dateError);

  try {
    const now = new Date();
    await atomically(db, (handle) => [
      handle
        .update(requests)
        .set({
          skill: input.skill ?? existing.skill,
          hoursPerWeek: input.hoursPerWeek === undefined ? existing.hoursPerWeek : hours2(input.hoursPerWeek),
          startsOn,
          endsOn,
          status: input.status ?? existing.status,
          updatedAt: now,
        })
        .where(and(eq(requests.id, id), isNull(requests.deletedAt))),
    ]);
    const row = await findResourceRequest(db, id);
    if (!row) return error.notFound(c, REQUEST_LABEL, id);
    publishResourceRequest(c, 'updated', row);
    return success(c, await presentRequestFor(c, row));
  } catch (err) {
    console.error('[flow-api/capacity] update request failed:', err);
    return error.internal(c, 'Failed to update resource request');
  }
});

app.delete('/requests/:id', requirePermission('portfolio:manage', 'projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findResourceRequest(db, id);
  if (!existing) return error.notFound(c, REQUEST_LABEL, id);
  if (!(await mayRequestFor(c, existing.projectId))) return error.forbidden(c, CAPACITY_MESSAGES.requestForbidden);

  try {
    const now = new Date();
    await atomically(db, (handle) => [
      handle.update(requests).set({ deletedAt: now, updatedAt: now }).where(and(eq(requests.id, id), isNull(requests.deletedAt))),
    ]);
    publishResourceRequest(c, 'deleted', existing);
    return noContent(c);
  } catch (err) {
    console.error('[flow-api/capacity] delete request failed:', err);
    return error.internal(c, 'Failed to delete resource request');
  }
});

app.get('/requests/:id/suggestions', requirePermission('portfolio:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const request = await findResourceRequest(db, id);
  if (!request) return error.notFound(c, REQUEST_LABEL, id);

  try {
    // The weeks of the request (at most 26), with tentative bookings: they hold the person too.
    const range = fitRange(request.startsOn, request.endsOn, todayUtc());
    const load = await loadCapacity(db, range, { includeTentative: true });
    const suggestions = suggestMembers(load, {
      skill: request.skill,
      hoursPerWeek: Number(request.hoursPerWeek),
      startsOn: request.startsOn,
      endsOn: request.endsOn,
    });
    // What several people free for part of the request add up to ("19 + 5 covers it").
    const totalFreeHoursPerWeek = round2(suggestions.reduce((sum, s) => sum + s.freeHoursPerWeek, 0));
    return success(c, {
      request: await presentRequestFor(c, request),
      suggestions,
      totalFreeHoursPerWeek,
      truncated: request.endsOn > range.to,
    });
  } catch (err) {
    console.error('[flow-api/capacity] suggestions failed:', err);
    return error.internal(c, 'Failed to suggest people');
  }
});

app.post('/requests/:id/book', requirePermission('portfolio:manage', 'projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const request = await findResourceRequest(db, id);
  if (!request) return error.notFound(c, REQUEST_LABEL, id);
  const body = await parseBody(c, bookResourceRequestSchema);
  if (!body.ok) return body.response;
  const input = body.data;
  if (!(await mayBook(c, { memberId: input.memberId, projectId: request.projectId }))) {
    return error.forbidden(c, CAPACITY_MESSAGES.bookingForbidden);
  }
  if (request.status !== 'open') return error.conflict(c, CAPACITY_MESSAGES.requestNotBookable);

  try {
    const now = new Date();
    const bookingId = generateId('bkg');
    await atomically(db, (handle) => [
      handle.insert(bookings).values({
        id: bookingId,
        memberId: input.memberId,
        projectId: request.projectId,
        requestId: null,
        startsOn: request.startsOn,
        endsOn: request.endsOn,
        hoursPerWeek: request.hoursPerWeek,
        tentative: input.tentative ?? false,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      }),
      handle
        .update(requests)
        .set({ status: 'booked', bookingId, updatedAt: now })
        .where(and(eq(requests.id, id), eq(requests.status, 'open'), isNull(requests.deletedAt))),
    ]);
    const [booking, updated] = await Promise.all([findBooking(db, bookingId), findResourceRequest(db, id)]);
    if (!booking || !updated) return error.internal(c, 'Failed to book resource request');
    publishBooking(c, 'created', booking);
    publishResourceRequest(c, 'updated', updated);
    return success(c, { booking: presentBooking(booking), request: await presentRequestFor(c, updated) }, 201);
  } catch (err) {
    console.error('[flow-api/capacity] book request failed:', err);
    return error.internal(c, 'Failed to book resource request');
  }
});

// ── Member profiles ─────────────────────────────────────────────────────────

app.get('/profiles', requirePermission('portfolio:read'), async (c) => {
  try {
    const rows = await c.get('tenantDb').select().from(profiles).orderBy(asc(profiles.memberId));
    return list(
      c,
      rows.map((row) => presentProfile(row, row.memberId)),
      cursorPagination(rows.length, false, null),
    );
  } catch (err) {
    console.error('[flow-api/capacity] list profiles failed:', err);
    return error.internal(c, 'Failed to list member profiles');
  }
});

app.get('/profiles/:memberId', requirePermission('portfolio:read'), async (c) => {
  const memberId = c.req.param('memberId');
  try {
    return success(c, presentProfile(await findProfile(c.get('tenantDb'), memberId), memberId));
  } catch (err) {
    console.error('[flow-api/capacity] get profile failed:', err);
    return error.internal(c, 'Failed to fetch member profile');
  }
});

app.put('/profiles/:memberId', requirePermission('portfolio:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const memberId = c.req.param('memberId');
  if (memberId !== userId && !(await canManagePortfolio(c))) return error.forbidden(c, CAPACITY_MESSAGES.profileForbidden);
  const body = await parseBody(c, updateMemberProfileSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  try {
    const now = new Date();
    const skills = input.skills === undefined ? undefined : normalizeSkills(input.skills);
    const weeklyHours = input.weeklyHours === undefined ? undefined : hours2(input.weeklyHours);
    await atomically(db, (handle) => [
      handle
        .insert(profiles)
        .values({
          id: generateId('fmp'),
          memberId,
          weeklyHours: weeklyHours ?? '40.00',
          skills: skills ?? [],
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: profiles.memberId,
          set: {
            ...(weeklyHours === undefined ? {} : { weeklyHours }),
            ...(skills === undefined ? {} : { skills }),
            updatedAt: now,
          },
        }),
    ]);
    const row = await findProfile(db, memberId);
    if (!row) return error.internal(c, 'Failed to save member profile');
    const profile = presentProfile(row, memberId);
    publishEntityEvent({ c, entityType: 'flow_member_profile', entityId: row.id, action: 'updated', data: { ...profile } });
    return success(c, profile);
  } catch (err) {
    console.error('[flow-api/capacity] save profile failed:', err);
    return error.internal(c, 'Failed to save member profile');
  }
});

export const capacityRoutes = app;
