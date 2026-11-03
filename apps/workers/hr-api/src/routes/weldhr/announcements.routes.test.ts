/**
 * Route tests for WeldHR announcements in the back office (/announcements),
 * against a real pglite tenant database through the whole /api/weldhr router.
 *
 * Publishing with `notify: true` fans out, after the response, an in-app
 * notification (and an Expo push where the member has a WeldHR device) to
 * every audience member linked to a workspace member except the author. Expo
 * is stubbed on `fetch` by URL, never by call order: in conformance mode the
 * outbound bridge replays the Rust server's calls into the same stub, and
 * every other request (the harness's own) goes to the real `fetch`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { announcementActionUrl, announcementPreview } from '../../services/weldhr/announcement-push';
import {
  HR_ADMIN,
  data,
  errorOf,
  hrCaller,
  hrDb,
  resetHr,
  seedDepartment,
  seedEmployee,
  seedMember,
} from '../../test/hr-fixtures';

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const realFetch = globalThis.fetch;

/** Expo's push API: every message gets an ok ticket. Anything else is the harness's own call. */
async function expo(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url !== EXPO_URL) return realFetch(input, init);
  const messages = JSON.parse(String(init?.body)) as Array<{ to: string }>;
  return new Response(JSON.stringify({ data: messages.map(() => ({ status: 'ok', id: 'ticket' })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let db: Database;

beforeAll(async () => {
  db = await hrDb();
}, 60_000);

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(expo));
  await resetHr(db);
  await seedMember(db, HR_ADMIN, { name: 'Hanna Admin', email: 'hanna@example.com' });
  await seedMember(db, 'user_anna', { name: 'Anna A', email: 'anna@example.com' });
  await seedMember(db, 'user_benn', { name: 'Ben B', email: 'ben@example.com' });
  await seedDepartment(db, 'hrdep_top', 'Head office');
  await seedDepartment(db, 'hrdep_sub', 'Support', 'hrdep_top');
  await seedDepartment(db, 'hrdep_far', 'Warehouse');
  await seedEmployee(db, { id: 'hremp_ann', userId: 'user_anna', email: 'anna@example.com', firstName: 'Ann', departmentId: 'hrdep_top' });
  await seedEmployee(db, { id: 'hremp_ben', userId: 'user_benn', email: 'ben@example.com', firstName: 'Ben', departmentId: 'hrdep_sub' });
  await seedEmployee(db, { id: 'hremp_cas', email: 'cas@example.com', firstName: 'Cas', departmentId: 'hrdep_far' });
  await seedEmployee(db, { id: 'hremp_dan', email: 'dan@example.com', firstName: 'Dan', status: 'terminated' });
  await seedEmployee(db, { id: 'hremp_hr', userId: HR_ADMIN, email: 'hanna@example.com', firstName: 'Hr', departmentId: 'hrdep_top' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const admin = () => hrCaller(db);
const as = (...grants: string[]) => hrCaller(db, { grants });

async function seedAnnouncement(id: string, fields: Partial<typeof schema.hrAnnouncements.$inferInsert> = {}) {
  await db.insert(schema.hrAnnouncements).values({
    id,
    title: `Title ${id}`,
    body: `Body of ${id}`,
    createdBy: HR_ADMIN,
    publishedAt: new Date('2026-02-01T09:00:00.000Z'),
    createdAt: new Date('2026-02-01T09:00:00.000Z'),
    updatedAt: new Date('2026-02-01T09:00:00.000Z'),
    ...fields,
  });
}

async function seedRead(id: string, announcementId: string, employeeId: string, readAt = '2026-03-02T10:00:00.000Z') {
  await db.insert(schema.hrAnnouncementReads).values({ id, announcementId, employeeId, readAt: new Date(readAt) });
}

describe('GET /announcements', () => {
  beforeEach(async () => {
    await seedAnnouncement('hrann_1', { title: 'Old but pinned', pinned: true, publishedAt: new Date('2026-01-01T09:00:00.000Z') });
    await seedAnnouncement('hrann_2', { title: 'Newest', departmentIds: ['hrdep_top'], publishedAt: new Date('2026-03-01T09:00:00.000Z') });
    await seedAnnouncement('hrann_3', { title: 'Middle', departmentIds: ['hrdep_far', 'hrdep_gone'] });
    await seedAnnouncement('hrann_4', { title: 'Deleted', deletedAt: new Date('2026-03-05T09:00:00.000Z') });
    await seedRead('hrann_r1', 'hrann_2', 'hremp_ann');
    // Cas is not in the audience of a Head office announcement: the read does not count.
    await seedRead('hrann_r2', 'hrann_2', 'hremp_cas');
    await seedRead('hrann_r3', 'hrann_1', 'hremp_ben');
  });

  it('lists pinned first, then newest, with department names, audience and reads', async () => {
    const res = await admin().get('/announcements');
    expect(res.status).toBe(200);
    const rows = await data<Array<Record<string, unknown>>>(res);
    expect(rows.map((r) => r.id)).toEqual(['hrann_1', 'hrann_2', 'hrann_3']);
    // Everyone not terminated: Ann, Ben, Cas and Hanna's own record.
    expect(rows[0]).toMatchObject({ pinned: true, departmentIds: [], departmentNames: [], audienceCount: 4, readCount: 1, createdByName: 'Hanna Admin' });
    // Head office and the department under it.
    expect(rows[1]).toMatchObject({ departmentNames: ['Head office'], audienceCount: 3, readCount: 1 });
    // A department that no longer exists has no name.
    expect(rows[2]).toMatchObject({ departmentIds: ['hrdep_far', 'hrdep_gone'], departmentNames: ['Warehouse'], audienceCount: 1, readCount: 0 });
  });

  it('needs announcements:read', async () => {
    expect((await as('announcements:create', 'employees:read').get('/announcements')).status).toBe(403);
  });
});

describe('POST /announcements', () => {
  it('publishes an announcement for some departments and answers it with its audience', async () => {
    const res = await admin().send('POST', '/announcements', {
      title: '  Summer party ',
      body: ' Friday at 4 ',
      pinned: true,
      departmentIds: ['hrdep_sub', 'hrdep_sub'],
    });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({
      title: 'Summer party',
      body: 'Friday at 4',
      pinned: true,
      departmentIds: ['hrdep_sub'],
      departmentNames: ['Support'],
      notifiedAt: null,
      createdBy: HR_ADMIN,
      createdByName: 'Hanna Admin',
      audienceCount: 1,
      readCount: 0,
    });
    expect(await db.select().from(schema.notifications)).toEqual([]);
  });

  it('notifies the audience after the response, but not the author', async () => {
    await db.insert(schema.deviceTokens).values({
      id: 'dt_hr_anna',
      userId: 'user_anna',
      deviceId: 'phone',
      platform: 'ios',
      token: 'ExponentPushToken[hr-anna]',
      tokenType: 'expo',
      appCode: 'weldhr',
      lastUsedAt: new Date('2026-01-01T10:00:00.000Z'),
    });
    const body = `Line one.\n\n${'Details '.repeat(30)}`;
    const res = await admin().send('POST', '/announcements', { title: 'New rota', body, notify: true });
    expect(res.status).toBe(201);
    const { id } = await data<{ id: string }>(res);

    await vi.waitFor(
      async () => {
        const [row] = await db.select().from(schema.hrAnnouncements).where(eq(schema.hrAnnouncements.id, id));
        expect(row!.notifiedAt).not.toBeNull();
      },
      { timeout: 5000 },
    );
    const notifications = await db.select().from(schema.notifications).where(eq(schema.notifications.entityId, id));
    expect(notifications.map((n) => n.userId).sort()).toEqual(['user_anna', 'user_benn']);
    expect(notifications[0]).toMatchObject({
      title: 'New rota',
      body: announcementPreview(body),
      category: 'weldhr',
      notificationType: 'hr_announcement',
      entityType: 'hr_announcement',
      actionUrl: announcementActionUrl(id),
      severity: 'info',
      actorType: 'user',
      actorId: HR_ADMIN,
      deliveredEmail: false,
    });
    expect(announcementPreview(body)).toHaveLength(160);
    expect(announcementPreview(body).endsWith('…')).toBe(true);

    const pushes = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([input]) => String(input) === EXPO_URL)
      .flatMap(([, init]) => JSON.parse(String(init?.body)) as Array<{ to: string; title: string }>);
    expect(pushes.length).toBeGreaterThan(0);
    expect(pushes.every((m) => m.to === 'ExponentPushToken[hr-anna]' && m.title === 'New rota')).toBe(true);
  });

  it('refuses an unknown or deleted department, bad input and a caller without announcements:create', async () => {
    const unknown = await admin().send('POST', '/announcements', { title: 'T', body: 'B', departmentIds: ['hrdep_top', 'hrdep_nope'] });
    expect(unknown.status).toBe(404);
    expect(await errorOf(unknown)).toEqual({ code: 'NOT_FOUND', message: "Department with ID 'hrdep_top,hrdep_nope' not found" });

    await db.update(schema.hrDepartments).set({ deletedAt: new Date('2026-03-01T00:00:00Z') }).where(eq(schema.hrDepartments.id, 'hrdep_far'));
    expect((await admin().send('POST', '/announcements', { title: 'T', body: 'B', departmentIds: ['hrdep_far'] })).status).toBe(404);

    const invalid = await admin().send('POST', '/announcements', { title: '   ', departmentIds: ['x'.repeat(31)] });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Title is required. Body is required. Department ids #1 can be at most 30 characters');

    expect((await as('announcements:read', 'announcements:update').send('POST', '/announcements', { title: 'T', body: 'B' })).status).toBe(403);
  });
});

describe('PATCH /announcements/:announcementId', () => {
  beforeEach(async () => {
    await seedAnnouncement('hrann_p1', { pinned: true, departmentIds: ['hrdep_top'] });
    await seedAnnouncement('hrann_p2', { deletedAt: new Date('2026-03-05T09:00:00.000Z') });
  });

  it('changes the text, pin and audience', async () => {
    const res = await admin().send('PATCH', '/announcements/hrann_p1', {
      title: ' Updated ',
      pinned: false,
      departmentIds: ['hrdep_far', 'hrdep_far'],
    });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({
      id: 'hrann_p1',
      title: 'Updated',
      body: 'Body of hrann_p1',
      pinned: false,
      departmentIds: ['hrdep_far'],
      departmentNames: ['Warehouse'],
      audienceCount: 1,
    });

    const everyone = await admin().send('PATCH', '/announcements/hrann_p1', { departmentIds: [] });
    expect(await data(everyone)).toMatchObject({ departmentIds: [], audienceCount: 4 });
  });

  it('refuses an unknown or deleted announcement, an unknown department, bad input and a caller without announcements:update', async () => {
    expect((await admin().send('PATCH', '/announcements/hrann_nope', { title: 'X' })).status).toBe(404);
    expect((await admin().send('PATCH', '/announcements/hrann_p2', { title: 'X' })).status).toBe(404);
    expect((await admin().send('PATCH', '/announcements/hrann_p1', { departmentIds: ['hrdep_nope'] })).status).toBe(404);
    const invalid = await admin().send('PATCH', '/announcements/hrann_p1', { body: '' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Body is required');
    expect((await as('announcements:create').send('PATCH', '/announcements/hrann_p1', { title: 'X' })).status).toBe(403);
  });
});

describe('DELETE /announcements/:announcementId', () => {
  it('soft-deletes the announcement', async () => {
    await seedAnnouncement('hrann_x1');
    expect((await as('announcements:update').send('DELETE', '/announcements/hrann_x1')).status).toBe(403);
    expect((await admin().send('DELETE', '/announcements/hrann_x1')).status).toBe(204);
    const [row] = await db.select().from(schema.hrAnnouncements).where(eq(schema.hrAnnouncements.id, 'hrann_x1'));
    expect(row!.deletedAt).not.toBeNull();
    expect(await data(await admin().get('/announcements'))).toEqual([]);
    expect((await admin().send('DELETE', '/announcements/hrann_x1')).status).toBe(404);
  });
});

describe('GET /announcements/:announcementId/reads', () => {
  it('lists the audience, unread first and then by name, with when each read it', async () => {
    await seedAnnouncement('hrann_g1', { departmentIds: ['hrdep_top'] });
    await seedRead('hrann_g1r', 'hrann_g1', 'hremp_ann', '2026-03-02T10:00:00.000Z');
    const res = await admin().get('/announcements/hrann_g1/reads');
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual([
      { employeeId: 'hremp_ben', employeeName: 'Ben Example', readAt: null },
      { employeeId: 'hremp_hr', employeeName: 'Hr Example', readAt: null },
      { employeeId: 'hremp_ann', employeeName: 'Ann Example', readAt: '2026-03-02T10:00:00.000Z' },
    ]);
  });

  it('is everyone for an announcement without departments', async () => {
    await seedAnnouncement('hrann_g2');
    const rows = await data<Array<{ employeeId: string }>>(await admin().get('/announcements/hrann_g2/reads'));
    expect(rows.map((r) => r.employeeId)).toEqual(['hremp_ann', 'hremp_ben', 'hremp_cas', 'hremp_hr']);
  });

  it('is a 404 for an unknown or deleted announcement and needs announcements:read', async () => {
    await seedAnnouncement('hrann_g3', { deletedAt: new Date('2026-03-05T09:00:00.000Z') });
    expect((await admin().get('/announcements/hrann_nope/reads')).status).toBe(404);
    expect((await admin().get('/announcements/hrann_g3/reads')).status).toBe(404);
    await seedAnnouncement('hrann_g4');
    expect((await as('announcements:update').get('/announcements/hrann_g4/reads')).status).toBe(403);
  });
});

