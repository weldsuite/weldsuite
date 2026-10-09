/**
 * DB-backed integration tests for /api/time-entries.
 *
 * Ownership model under test:
 *   - GET /           own-scoped by default; `scope=team` widens to the whole
 *                     project team but only for a manager (canManageProject).
 *   - GET /team-summary  per-member rollup; same manager gate.
 *   - GET /:id        owner-only; another user's entry returns 404.
 *   - PATCH /:id      owner-only; another user's entry returns 404.
 *   - DELETE /:id     owner-only; another user's entry returns 404.
 *   - PATCH /:id/approve  cross-user (manager workflow) — NOT blocked.
 *   - PATCH /:id/reject   cross-user (manager workflow) — NOT blocked.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { timeEntriesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

// Helper: insert a raw time entry for a given user.
async function seedEntry(
  database: Database,
  id: string,
  userId: string,
  overrides: Record<string, unknown> = {},
) {
  const now = new Date();
  await database
    .insert(schema.timeEntries)
    .values({
      id,
      userId,
      date: '2026-06-01',
      duration: '60',
      billable: true,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    } as typeof schema.timeEntries.$inferInsert)
    .onConflictDoNothing();
}

// Helper: a project whose manager is `managerId`. `canManageProject` treats the
// project manager as an owner even without a project_members row.
async function seedProject(database: Database, id: string, managerId: string) {
  const now = new Date();
  await database
    .insert(schema.projects)
    .values({
      id,
      name: `Project ${id}`,
      projectManagerId: managerId,
      createdAt: now,
      updatedAt: now,
    } as typeof schema.projects.$inferInsert)
    .onConflictDoNothing();
}

// Helper: an active project_members row.
async function seedMember(
  database: Database,
  id: string,
  projectId: string,
  userId: string,
  role: string,
) {
  const now = new Date();
  await database
    .insert(schema.projectMembers)
    .values({
      id,
      projectId,
      userId,
      role,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      joinedAt: now,
    } as typeof schema.projectMembers.$inferInsert)
    .onConflictDoNothing();
}

describe('/api/time-entries · pglite integration', () => {
  // -----------------------------------------------------------------------
  // POST / — create always stamps the caller's userId
  // -----------------------------------------------------------------------

  it('POST / creates an entry stamped with the caller userId', async () => {
    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:create'),
        userId: 'user_creator',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-06-01', duration: 90 }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^time_/);

    const [row] = await db
      .select()
      .from(schema.timeEntries)
      .where(
        and(
          eq(schema.timeEntries.id, body.data.id),
          eq(schema.timeEntries.userId, 'user_creator'),
        ),
      )
      .limit(1);
    expect(row?.userId).toBe('user_creator');
    expect(Number(row?.duration)).toBe(90);
  });

  // -----------------------------------------------------------------------
  // Daily limit — no user can log more than 24h on a single day
  // -----------------------------------------------------------------------

  function appFor(userId: string, ...perms: Parameters<typeof permissions>) {
    return createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: { permissions: permissions(...perms), userId, tenantDb: db },
    }).request;
  }

  async function post(
    request: ReturnType<typeof appFor>,
    body: Record<string, unknown>,
  ) {
    return request('/api/time-entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('POST / rejects a single entry longer than 24h', async () => {
    const request = appFor('user_cap_single', 'time:create');
    // 31h 30m — the exact value from the QA report.
    const res = await post(request, { date: '2026-10-08', duration: '1890' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/24 hours/);

    const rows = await db
      .select()
      .from(schema.timeEntries)
      .where(eq(schema.timeEntries.userId, 'user_cap_single'));
    expect(rows).toHaveLength(0);
  });

  it('POST / accepts a full 24h day but rejects any further time that day', async () => {
    const request = appFor('user_cap_full', 'time:create');
    expect((await post(request, { date: '2026-10-08', duration: 1440 })).status).toBe(201);

    const res = await post(request, { date: '2026-10-08', duration: 1 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/already has 24h logged/);
  });

  it('POST / rejects an entry that pushes the day total past 24h', async () => {
    const request = appFor('user_cap_sum', 'time:create');
    expect((await post(request, { date: '2026-10-08', duration: 600 })).status).toBe(201);
    expect((await post(request, { date: '2026-10-08', duration: 600 })).status).toBe(201);
    // 20h logged; 5h more would make 25h.
    expect((await post(request, { date: '2026-10-08', duration: 300 })).status).toBe(400);
    // Exactly 4h more lands on 24h.
    expect((await post(request, { date: '2026-10-08', duration: 240 })).status).toBe(201);
  });

  it('POST / counts each day and each user separately', async () => {
    const request = appFor('user_cap_scope', 'time:create');
    await seedEntry(db, 'time_cap_scope_other_user', 'user_cap_scope_other', {
      date: '2026-10-08',
      duration: '1000',
    });
    expect((await post(request, { date: '2026-10-08', duration: 1000 })).status).toBe(201);
    // A different day starts from zero.
    expect((await post(request, { date: '2026-10-09', duration: 1000 })).status).toBe(201);
  });

  it('POST / ignores soft-deleted entries when summing the day', async () => {
    const request = appFor('user_cap_deleted', 'time:create');
    await seedEntry(db, 'time_cap_deleted', 'user_cap_deleted', {
      date: '2026-10-08',
      duration: '1400',
      deletedAt: new Date(),
    });
    expect((await post(request, { date: '2026-10-08', duration: 1000 })).status).toBe(201);
  });

  it('POST / rejects a negative or non-numeric duration', async () => {
    const request = appFor('user_cap_invalid', 'time:create');
    expect((await post(request, { date: '2026-10-08', duration: -5 })).status).toBe(400);
    expect((await post(request, { date: '2026-10-08', duration: 'abc' })).status).toBe(400);
    expect((await post(request, { date: '2026-10-08', duration: '' })).status).toBe(400);
  });

  it('PATCH /:id rejects a duration that takes the day past 24h', async () => {
    await seedEntry(db, 'time_cap_patch_a', 'user_cap_patch', { date: '2026-10-08', duration: '600' });
    await seedEntry(db, 'time_cap_patch_b', 'user_cap_patch', { date: '2026-10-08', duration: '300' });
    const request = appFor('user_cap_patch', 'time:update');

    const tooLong = await request('/api/time-entries/time_cap_patch_a', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 1200 }),
    });
    expect(tooLong.status).toBe(400);

    // The entry being edited is excluded from its own day total: 1140 + 300 = 24h.
    const fits = await request('/api/time-entries/time_cap_patch_a', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 1140 }),
    });
    expect(fits.status).toBe(200);
  });

  it('PATCH /:id rejects moving an entry onto a day that would overflow', async () => {
    await seedEntry(db, 'time_cap_move_full', 'user_cap_move', { date: '2026-10-09', duration: '1400' });
    await seedEntry(db, 'time_cap_move_src', 'user_cap_move', { date: '2026-10-08', duration: '120' });
    const request = appFor('user_cap_move', 'time:update');

    const res = await request('/api/time-entries/time_cap_move_src', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-10-09' }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /:id leaves non-duration edits alone on an already-overfull day', async () => {
    // Legacy data (logged before the cap existed) must stay editable.
    await seedEntry(db, 'time_cap_legacy', 'user_cap_legacy', { date: '2026-10-08', duration: '1890' });
    const request = appFor('user_cap_legacy', 'time:update');

    const res = await request('/api/time-entries/time_cap_legacy', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Fix the typo later' }),
    });
    expect(res.status).toBe(200);

    // ...and shrinking it to a sane value works.
    const shrink = await request('/api/time-entries/time_cap_legacy', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 60 }),
    });
    expect(shrink.status).toBe(200);
  });

  // -----------------------------------------------------------------------
  // GET / — own scope labels entries with their task and author
  // -----------------------------------------------------------------------

  it('GET / resolves the task title and the author on the caller\'s own entries', async () => {
    const now = new Date();
    await db
      .insert(schema.workspaceMembers)
      .values({
        id: 'wm_label_user',
        userId: 'user_label',
        name: 'Gert van den Berg',
        email: 'gert@example.com',
        createdAt: now,
        updatedAt: now,
      } as typeof schema.workspaceMembers.$inferInsert)
      .onConflictDoNothing();
    await db
      .insert(schema.tasks)
      .values({
        id: 'task_label_one',
        title: 'E2E task one',
        createdAt: now,
        updatedAt: now,
      } as typeof schema.tasks.$inferInsert)
      .onConflictDoNothing();
    await seedEntry(db, 'time_label_a', 'user_label', {
      taskId: 'task_label_one',
      description: 'E2E time entry',
    });
    await seedEntry(db, 'time_label_b', 'user_label', {
      taskId: 'task_label_one',
      description: 'Timer run',
    });
    await seedEntry(db, 'time_label_c', 'user_label', { description: 'No task here' });

    const request = appFor('user_label', 'time:read');
    const res = await request('/api/time-entries');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        id: string;
        description: string;
        duration: string;
        user: { name: string };
        task?: { id: string; title: string };
      }[];
    };
    const byId = new Map(body.data.map((r) => [r.id, r]));
    for (const id of ['time_label_a', 'time_label_b']) {
      expect(byId.get(id)?.task).toEqual({ id: 'task_label_one', title: 'E2E task one' });
      expect(byId.get(id)?.user.name).toBe('Gert van den Berg');
    }
    expect(byId.get('time_label_c')?.task).toBeUndefined();
    // The full row is still returned for the personal timesheet.
    expect(byId.get('time_label_a')?.duration).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // GET / — list is always scoped to own entries
  // -----------------------------------------------------------------------

  it('GET / returns only the caller\'s own entries', async () => {
    await seedEntry(db, 'time_alice_list', 'user_alice');
    await seedEntry(db, 'time_bob_list', 'user_bob');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read'),
        userId: 'user_alice',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; userId: string }[] };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain('time_alice_list');
    expect(ids).not.toContain('time_bob_list');
    for (const row of body.data) {
      expect(row.userId).toBe('user_alice');
    }
  });

  it('GET / ignores the userId query param on the default own scope', async () => {
    // Even if the caller passes userId=user_alice in the query string while
    // logged in as user_carol, they must only see their own entries.
    await seedEntry(db, 'time_alice_qs', 'user_alice');
    await seedEntry(db, 'time_carol_qs', 'user_carol');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read'),
        userId: 'user_carol',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries?userId=user_alice');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    const ids = body.data.map((r) => r.id);
    expect(ids).not.toContain('time_alice_qs');
    expect(ids).toContain('time_carol_qs');
  });

  // -----------------------------------------------------------------------
  // GET /?scope=team — manager-only widening
  // -----------------------------------------------------------------------

  it('GET /?scope=team returns every member\'s entries for a project manager', async () => {
    const proj = 'proj_team_list';
    await seedProject(db, proj, 'user_pm');
    await seedMember(db, `${proj}_worker`, proj, 'user_worker', 'member');
    await seedEntry(db, 'time_team_pm', 'user_pm', { projectId: proj });
    await seedEntry(db, 'time_team_worker', 'user_worker', { projectId: proj });

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read', 'projects:read'),
        userId: 'user_pm',
        tenantDb: db,
      },
    });

    const res = await request(`/api/time-entries?scope=team&projectId=${proj}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; userId: string; user?: { name: string } }[];
    };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain('time_team_pm');
    expect(ids).toContain('time_team_worker');
    // The join must label rows the caller did not author. No workspace_members
    // row is seeded here, so the name falls back to the user id — the point is
    // that the shape is present and non-empty.
    const worker = body.data.find((r) => r.id === 'time_team_worker');
    expect(worker?.user?.name).toBeTruthy();
  });

  it('GET /?scope=team is forbidden for a plain project member', async () => {
    const proj = 'proj_team_denied_member';
    await seedProject(db, proj, 'user_pm');
    await seedMember(db, `${proj}_worker`, proj, 'user_worker', 'member');
    await seedEntry(db, 'time_team_denied', 'user_pm', { projectId: proj });

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read', 'projects:read'),
        userId: 'user_worker',
        tenantDb: db,
      },
    });

    const res = await request(`/api/time-entries?scope=team&projectId=${proj}`);
    expect(res.status).toBe(403);
  });

  it('GET /?scope=team is forbidden for a non-member entirely', async () => {
    const proj = 'proj_team_denied_outsider';
    await seedProject(db, proj, 'user_pm');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read', 'projects:read'),
        userId: 'user_outsider',
        tenantDb: db,
      },
    });

    const res = await request(`/api/time-entries?scope=team&projectId=${proj}`);
    expect(res.status).toBe(403);
  });

  it('GET /?scope=team requires a projectId', async () => {
    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read', 'projects:read'),
        userId: 'user_pm',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries?scope=team');
    expect(res.status).toBe(400);
  });

  it('GET /?scope=team honours userId to narrow to one member', async () => {
    const proj = 'proj_team_narrow';
    await seedProject(db, proj, 'user_pm');
    await seedMember(db, `${proj}_worker`, proj, 'user_worker', 'member');
    await seedEntry(db, 'time_narrow_pm', 'user_pm', { projectId: proj });
    await seedEntry(db, 'time_narrow_worker', 'user_worker', { projectId: proj });

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read', 'projects:read'),
        userId: 'user_pm',
        tenantDb: db,
      },
    });

    const res = await request(
      `/api/time-entries?scope=team&projectId=${proj}&userId=user_worker`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain('time_narrow_worker');
    expect(ids).not.toContain('time_narrow_pm');
  });

  // -----------------------------------------------------------------------
  // GET /team-summary — per-member rollup, same manager gate
  // -----------------------------------------------------------------------

  it('GET /team-summary rolls up hours per member with the billable split', async () => {
    const proj = 'proj_summary_rollup';
    await seedProject(db, proj, 'user_pm');
    await seedMember(db, `${proj}_worker`, proj, 'user_worker', 'member');
    // 60 billable + 30 non-billable for the worker, 120 billable for the PM.
    await seedEntry(db, 'time_rollup_w1', 'user_worker', { projectId: proj, duration: '60' });
    await seedEntry(db, 'time_rollup_w2', 'user_worker', {
      projectId: proj,
      duration: '30',
      billable: false,
    });
    await seedEntry(db, 'time_rollup_pm', 'user_pm', { projectId: proj, duration: '120' });

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read', 'projects:read'),
        userId: 'user_pm',
        tenantDb: db,
      },
    });

    const res = await request(`/api/time-entries/team-summary?projectId=${proj}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        totals: { totalMinutes: number; billableMinutes: number; nonBillableMinutes: number };
        members: {
          userId: string;
          totalMinutes: number;
          billableMinutes: number;
          nonBillableMinutes: number;
          entryCount: number;
        }[];
        entries: { id: string }[];
      };
    };

    expect(body.data.totals.totalMinutes).toBe(210);
    expect(body.data.totals.billableMinutes).toBe(180);
    expect(body.data.totals.nonBillableMinutes).toBe(30);

    const worker = body.data.members.find((m) => m.userId === 'user_worker');
    expect(worker?.totalMinutes).toBe(90);
    expect(worker?.billableMinutes).toBe(60);
    expect(worker?.nonBillableMinutes).toBe(30);
    expect(worker?.entryCount).toBe(2);

    // Sorted by hours desc — the PM logged the most.
    expect(body.data.members[0]?.userId).toBe('user_pm');
    expect(body.data.entries).toHaveLength(3);
  });

  it('GET /team-summary includes roster members who logged nothing', async () => {
    const proj = 'proj_summary_idle';
    await seedProject(db, proj, 'user_pm');
    await seedMember(db, `${proj}_idle`, proj, 'user_idle', 'member');
    await seedEntry(db, 'time_idle_pm', 'user_pm', { projectId: proj, duration: '60' });

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read', 'projects:read'),
        userId: 'user_pm',
        tenantDb: db,
      },
    });

    const res = await request(`/api/time-entries/team-summary?projectId=${proj}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { members: { userId: string; totalMinutes: number }[] };
    };
    const idle = body.data.members.find((m) => m.userId === 'user_idle');
    expect(idle).toBeDefined();
    expect(idle?.totalMinutes).toBe(0);
  });

  it('GET /team-summary counts a contributor who has left the roster', async () => {
    // A former member's hours still belong to the project; dropping them would
    // silently understate the total.
    const proj = 'proj_summary_leaver';
    await seedProject(db, proj, 'user_pm');
    await seedEntry(db, 'time_leaver', 'user_gone', { projectId: proj, duration: '45' });
    // Still in the workspace directory, just off this project's roster — the
    // rollup should show their real name, not a raw user id.
    await db
      .insert(schema.workspaceMembers)
      .values({
        id: 'wm_gone',
        userId: 'user_gone',
        name: 'Gone Contributor',
        email: 'gone@example.com',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as typeof schema.workspaceMembers.$inferInsert)
      .onConflictDoNothing();

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read', 'projects:read'),
        userId: 'user_pm',
        tenantDb: db,
      },
    });

    const res = await request(`/api/time-entries/team-summary?projectId=${proj}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        totals: { totalMinutes: number };
        members: {
          userId: string;
          name: string;
          totalMinutes: number;
          isActiveMember: boolean;
        }[];
      };
    };
    expect(body.data.totals.totalMinutes).toBe(45);
    const gone = body.data.members.find((m) => m.userId === 'user_gone');
    expect(gone?.isActiveMember).toBe(false);
    expect(gone?.totalMinutes).toBe(45);
    expect(gone?.name).toBe('Gone Contributor');
  });

  it('GET /team-summary keeps totals exact when the entry list is capped', async () => {
    // The whole point of aggregating totals in SQL: a capped `entries` array
    // must not understate `totals`. The UI warns off the CSV export on this
    // flag, so it has to flip when — and only when — rows were dropped.
    const proj = 'proj_summary_cap';
    await seedProject(db, proj, 'user_pm');
    for (const n of [1, 2, 3]) {
      await seedEntry(db, `time_cap_${n}`, 'user_pm', { projectId: proj, duration: '30' });
    }

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read', 'projects:read'),
        userId: 'user_pm',
        tenantDb: db,
      },
    });

    const capped = await request(`/api/time-entries/team-summary?projectId=${proj}&limit=2`);
    expect(capped.status).toBe(200);
    const cappedBody = (await capped.json()) as {
      data: {
        totals: { totalMinutes: number; entryCount: number };
        entries: unknown[];
        entriesTruncated: boolean;
      };
    };
    expect(cappedBody.data.entries).toHaveLength(2);
    expect(cappedBody.data.totals.entryCount).toBe(3);
    expect(cappedBody.data.totals.totalMinutes).toBe(90);
    expect(cappedBody.data.entriesTruncated).toBe(true);

    // Same data, room for every row — the flag must stay down.
    const full = await request(`/api/time-entries/team-summary?projectId=${proj}&limit=10`);
    const fullBody = (await full.json()) as {
      data: { entries: unknown[]; entriesTruncated: boolean };
    };
    expect(fullBody.data.entries).toHaveLength(3);
    expect(fullBody.data.entriesTruncated).toBe(false);
  });

  it('GET /team-summary respects the date range', async () => {
    const proj = 'proj_summary_range';
    await seedProject(db, proj, 'user_pm');
    await seedEntry(db, 'time_range_in', 'user_pm', {
      projectId: proj,
      duration: '60',
      date: '2026-06-10',
    });
    await seedEntry(db, 'time_range_out', 'user_pm', {
      projectId: proj,
      duration: '999',
      date: '2026-07-10',
    });

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read', 'projects:read'),
        userId: 'user_pm',
        tenantDb: db,
      },
    });

    const res = await request(
      `/api/time-entries/team-summary?projectId=${proj}&fromDate=2026-06-01&toDate=2026-06-30`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { totals: { totalMinutes: number } } };
    expect(body.data.totals.totalMinutes).toBe(60);
  });

  it('GET /team-summary is forbidden for a plain project member', async () => {
    const proj = 'proj_summary_denied';
    await seedProject(db, proj, 'user_pm');
    await seedMember(db, `${proj}_worker`, proj, 'user_worker', 'member');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read', 'projects:read'),
        userId: 'user_worker',
        tenantDb: db,
      },
    });

    const res = await request(`/api/time-entries/team-summary?projectId=${proj}`);
    expect(res.status).toBe(403);
  });

  it('GET /team-summary allows an owner/admin project member', async () => {
    const proj = 'proj_summary_admin';
    await seedProject(db, proj, 'user_pm');
    await seedMember(db, `${proj}_lead`, proj, 'user_lead', 'admin');
    await seedEntry(db, 'time_admin_pm', 'user_pm', { projectId: proj, duration: '60' });

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read', 'projects:read'),
        userId: 'user_lead',
        tenantDb: db,
      },
    });

    const res = await request(`/api/time-entries/team-summary?projectId=${proj}`);
    expect(res.status).toBe(200);
  });

  it('GET /team-summary is not shadowed by GET /:id', async () => {
    // `/team-summary` must stay registered above `/:id`, or Hono treats it as
    // an entry id and the endpoint 404s for everyone.
    const proj = 'proj_summary_routing';
    await seedProject(db, proj, 'user_pm');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read', 'projects:read'),
        userId: 'user_pm',
        tenantDb: db,
      },
    });

    const res = await request(`/api/time-entries/team-summary?projectId=${proj}`);
    expect(res.status).not.toBe(404);
  });

  // -----------------------------------------------------------------------
  // GET /:id — owner-only
  // -----------------------------------------------------------------------

  it('GET /:id returns the entry for the owning user', async () => {
    await seedEntry(db, 'time_get_own', 'user_dave');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read'),
        userId: 'user_dave',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries/time_get_own');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe('time_get_own');
  });

  it('GET /:id returns 404 when the entry belongs to a different user', async () => {
    await seedEntry(db, 'time_get_other', 'user_eve');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:read'),
        userId: 'user_frank',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries/time_get_other');
    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // PATCH /:id — owner-only
  // -----------------------------------------------------------------------

  it('PATCH /:id updates the entry for the owning user', async () => {
    await seedEntry(db, 'time_patch_own', 'user_grace');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:update'),
        userId: 'user_grace',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries/time_patch_own', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Updated by owner' }),
    });
    expect(res.status).toBe(200);
  });

  it('PATCH /:id returns 404 when the caller does not own the entry', async () => {
    await seedEntry(db, 'time_patch_other', 'user_henry');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:update'),
        userId: 'user_iris',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries/time_patch_other', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Should be blocked' }),
    });
    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // DELETE /:id — owner-only
  // -----------------------------------------------------------------------

  it('DELETE /:id soft-deletes the entry for the owning user', async () => {
    await seedEntry(db, 'time_delete_own', 'user_jack');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:delete'),
        userId: 'user_jack',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries/time_delete_own', { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('DELETE /:id returns 404 when the caller does not own the entry', async () => {
    await seedEntry(db, 'time_delete_other', 'user_karen');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:delete'),
        userId: 'user_leo',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries/time_delete_other', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // PATCH /:id/approve — cross-user (manager workflow), must NOT be blocked
  // -----------------------------------------------------------------------

  it('PATCH /:id/approve approves an entry owned by a different user (manager flow)', async () => {
    await seedEntry(db, 'time_approve_other', 'user_mary');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:update'),
        userId: 'user_manager',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries/time_approve_other/approve', {
      method: 'PATCH',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe('approved');

    const [row] = await db
      .select()
      .from(schema.timeEntries)
      .where(eq(schema.timeEntries.id, 'time_approve_other'))
      .limit(1);
    expect(row?.status).toBe('approved');
    expect(row?.approvedBy).toBe('user_manager');
  });

  // -----------------------------------------------------------------------
  // PATCH /:id/reject — cross-user (manager workflow), must NOT be blocked
  // -----------------------------------------------------------------------

  it('PATCH /:id/reject rejects an entry owned by a different user (manager flow)', async () => {
    await seedEntry(db, 'time_reject_other', 'user_nancy');

    const { request } = createTestApp('/api/time-entries', timeEntriesRoutes, {
      context: {
        permissions: permissions('time:update'),
        userId: 'user_manager2',
        tenantDb: db,
      },
    });

    const res = await request('/api/time-entries/time_reject_other/reject', {
      method: 'PATCH',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe('rejected');

    const [row] = await db
      .select()
      .from(schema.timeEntries)
      .where(eq(schema.timeEntries.id, 'time_reject_other'))
      .limit(1);
    expect(row?.status).toBe('rejected');
  });
});
