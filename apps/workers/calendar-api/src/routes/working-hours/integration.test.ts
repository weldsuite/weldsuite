/**
 * DB-backed integration tests for /api/working-hours: one's own schedule,
 * the team overview and an admin setting a member's.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { workingHoursRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_wh_ann', userId: 'user_wh_ann', email: 'ann@example.com', name: 'Ann', status: 'ACTIVE' },
    { id: 'wm_wh_bob', userId: 'user_wh_bob', email: 'bob@example.com', name: 'Bob', status: 'ACTIVE' },
    { id: 'wm_wh_gone', userId: 'user_wh_gone', email: 'gone@example.com', name: 'Gone', status: 'SUSPENDED' },
  ]);
}, 60_000);

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function api(userId: string, perms: string[], orgId: string | null = 'org_test_default') {
  return createTestApp('/api/working-hours', workingHoursRoutes, {
    context: { permissions: permissions(...perms), userId, orgId, tenantDb: db },
  }).request;
}

const weekdays = {
  monday: { isOpen: true, openTime: '09:00', closeTime: '17:00', breaks: [{ start: '12:00', end: '12:30' }] },
  saturday: { isOpen: false },
};

async function prefs(userId: string) {
  return db
    .select()
    .from(schema.userPreferences)
    .where(and(eq(schema.userPreferences.userId, userId), isNull(schema.userPreferences.deletedAt)));
}

describe('/api/working-hours (self)', () => {
  it('reads null before anything is set, then what was saved', async () => {
    const request = api('user_wh_ann', ['general:read', 'working-hours:edit-self']);
    const empty = await request('/api/working-hours');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ data: { workingHours: null } });

    const saved = await request('/api/working-hours', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ workingHours: { ...weekdays, extra: true } }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ data: { workingHours: weekdays } });
    expect((await prefs('user_wh_ann'))[0]?.workingHours).toEqual(weekdays);

    // A second save updates the same row.
    const again = await request('/api/working-hours', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ workingHours: { sunday: { isOpen: false } } }),
    });
    expect(again.status).toBe(200);
    expect(await prefs('user_wh_ann')).toHaveLength(1);
    expect(await (await request('/api/working-hours')).json()).toEqual({
      data: { workingHours: { sunday: { isOpen: false } } },
    });
  });

  it('validates the schedule', async () => {
    const request = api('user_wh_ann', ['working-hours:edit-self']);
    for (const body of [{}, { workingHours: { monday: { openTime: '09:00' } } }, { workingHours: { monday: { isOpen: true, breaks: [{ start: 9 }] } } }]) {
      const res = await request('/api/working-hours', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('lets team admins save their own hours, nobody else', async () => {
    const admin = await api('user_wh_bob', ['team:update'])('/api/working-hours', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ workingHours: weekdays }),
    });
    expect(admin.status).toBe(200);
    const denied = await api('user_wh_bob', ['general:read'])('/api/working-hours', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ workingHours: weekdays }),
    });
    expect(denied.status).toBe(403);
    expect((await api('user_wh_bob', [])('/api/working-hours')).status).toBe(403);
  });
});

describe('/api/working-hours/team and /members/:memberId', () => {
  it('lists the active members with their hours', async () => {
    const res = await api('user_wh_admin', ['team:read'])('/api/working-hours/team');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; name: string; workingHours: unknown }[] };
    expect(body.data.map((m) => m.id)).toEqual(['wm_wh_ann', 'wm_wh_bob']);
  });

  it('reads and sets a member\'s hours', async () => {
    const read = api('user_wh_admin', ['team:read', 'team:update']);
    const res = await read('/api/working-hours/members/wm_wh_bob');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { memberName: string } }).data.memberName).toBe('Bob');

    const set = await read('/api/working-hours/members/wm_wh_gone', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ workingHours: weekdays }),
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ data: { memberId: 'wm_wh_gone', workingHours: weekdays } });
    expect((await prefs('user_wh_gone'))[0]?.workingHours).toEqual(weekdays);
  });

  it('answers 404 for an unknown member, 400 without a workspace or a valid body, 403 without permission', async () => {
    const request = api('user_wh_admin', ['team:read', 'team:update']);
    expect((await request('/api/working-hours/members/wm_missing')).status).toBe(404);
    expect((await request('/api/working-hours/members/wm_missing', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ workingHours: weekdays }),
    })).status).toBe(404);
    expect((await request('/api/working-hours/members/wm_wh_bob', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ workingHours: 'nine to five' }),
    })).status).toBe(400);

    const orgless = api('user_wh_admin', ['team:read', 'team:update'], null);
    expect((await orgless('/api/working-hours/team')).status).toBe(400);
    expect((await orgless('/api/working-hours/members/wm_wh_bob')).status).toBe(400);
    expect((await orgless('/api/working-hours/members/wm_wh_bob', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ workingHours: weekdays }),
    })).status).toBe(400);

    const reader = api('user_wh_admin', ['general:read']);
    expect((await reader('/api/working-hours/team')).status).toBe(403);
    expect((await reader('/api/working-hours/members/wm_wh_bob')).status).toBe(403);
    expect((await reader('/api/working-hours/members/wm_wh_bob', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ workingHours: weekdays }),
    })).status).toBe(403);
  });
});
