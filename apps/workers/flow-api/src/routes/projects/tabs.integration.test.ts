/**
 * DB-backed integration tests for PUT /api/projects/:id/tabs: which project
 * tabs are hidden, for the project, per role and per member. Runs against the
 * TypeScript worker and, in conformance mode, the Rust backend
 * (rust/conformance/suites.json), so every status, message and event asserted
 * here is the contract of both.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { projectsRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const MANAGER = 'user_tab_manager';
const ADMIN = 'user_tab_admin';
const MEMBER = 'user_tab_member';
const VIEWER = 'user_tab_viewer';
const OUTSIDER = 'user_tab_outsider';

const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete'];

let db: Database;

function as(userId: string, keys: string[] = FULL) {
  const { request } = createTestApp('/api/projects', projectsRoutes, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
  });
  return (projectId: string, body: unknown) =>
    request(`/api/projects/${projectId}/tabs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

const published = vi.mocked(publishEntityEvent);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  published.mockClear();
});

async function seedProject(id: string, settings: Record<string, unknown> | null = null) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({ id, name: id, projectManagerId: MANAGER, settings, createdAt: now, updatedAt: now });
  await db.insert(schema.projectMembers).values([
    { id: `pm_${id}_a`, projectId: id, userId: ADMIN, role: 'admin', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
    { id: `pm_${id}_m`, projectId: id, userId: MEMBER, role: 'member', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
    { id: `pm_${id}_v`, projectId: id, userId: VIEWER, role: 'viewer', isActive: true, createdAt: now, updatedAt: now, joinedAt: now },
  ]);
}

async function settingsOf(id: string) {
  const [row] = await db.select({ settings: schema.projects.settings }).from(schema.projects).where(eq(schema.projects.id, id));
  return row?.settings;
}

const BODY = {
  hidden: ['raid', 'governance', 'raid'],
  roles: { member: ['finance'], viewer: ['finance', 'timesheet', 'finance'] },
  members: [
    { userId: MEMBER, hidden: ['analytics', 'analytics'] },
    { userId: MEMBER, hidden: ['files'] },
    { userId: VIEWER, hidden: [] },
  ],
};

const STORED = {
  hidden: ['raid', 'governance'],
  roles: { member: ['finance'], viewer: ['finance', 'timesheet'] },
  members: [
    { userId: MEMBER, hidden: ['analytics'] },
    { userId: VIEWER, hidden: [] },
  ],
};

describe('PUT /api/projects/:id/tabs', () => {
  it('stores the tab settings without repeats and keeps the other settings keys', async () => {
    await seedProject('prj_tab_put', { sponsorId: 'user_sponsor', schedule: { workingDays: [1, 2, 3, 4, 5], holidays: [], autoSchedule: false } });

    const res = await as(MANAGER)('prj_tab_put', BODY);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual(STORED);
    expect(await settingsOf('prj_tab_put')).toEqual({
      sponsorId: 'user_sponsor',
      schedule: { workingDays: [1, 2, 3, 4, 5], holidays: [], autoSchedule: false },
      tabs: STORED,
    });
    expect(published).toHaveBeenCalledTimes(1);
    expect(published.mock.calls[0]?.[0]).toMatchObject({ entityType: 'project', action: 'updated', entityId: 'prj_tab_put' });

    // Written whole: a second save replaces the first.
    const cleared = { hidden: [], roles: { member: [], viewer: [] }, members: [] };
    const again = await as(MANAGER)('prj_tab_put', cleared);
    expect(again.status).toBe(200);
    expect(((await settingsOf('prj_tab_put')) as { tabs: unknown }).tabs).toEqual(cleared);
  });

  it('lets project admins save, and refuses members, viewers and outsiders', async () => {
    await seedProject('prj_tab_who');
    expect((await as(ADMIN)('prj_tab_who', BODY)).status).toBe(200);

    for (const userId of [MEMBER, VIEWER, OUTSIDER]) {
      const res = await as(userId)('prj_tab_who', BODY);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
        'You do not have manage access to this project',
      );
    }
    expect((await as(MANAGER, ['projects:read'])('prj_tab_who', BODY)).status).toBe(403);
  });

  it('answers 404 for a project that does not exist', async () => {
    expect((await as(MANAGER)('prj_tab_ghost', BODY)).status).toBe(404);
  });

  it('refuses a body that is not the whole tab settings', async () => {
    await seedProject('prj_tab_bad');
    const refused = [
      { hidden: [] },
      { ...BODY, hidden: 'raid' },
      { ...BODY, hidden: [''] },
      { ...BODY, roles: { member: [], viewer: [], owner: [] } },
      { ...BODY, members: [{ userId: MEMBER }] },
      { ...BODY, extra: true },
      { ...BODY, hidden: Array.from({ length: 51 }, (_, i) => `tab${i}`) },
    ];
    for (const body of refused) {
      const res = await as(MANAGER)('prj_tab_bad', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Invalid request body');
    }
    expect((await as(MANAGER)('prj_tab_bad', '{not json')).status).toBe(400);
    expect(await settingsOf('prj_tab_bad')).toBeNull();
  });
});
