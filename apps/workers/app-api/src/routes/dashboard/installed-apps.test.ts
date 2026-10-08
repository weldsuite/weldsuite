/**
 * pglite-backed test for GET /api/dashboard/installed-apps.
 *
 * Admins see every installed app; other members see the apps their role or
 * per-user assignments grant. EMPLOYEE members (WeldHR) always get exactly
 * the installed subset of WeldHR + WeldChat, matching their fixed permission
 * set, even with no role id or assignments.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { dashboardRoutes } from './index';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { workspaceInstalledApps, workspaceMembers } = schema;

let db: Database;

async function seedMember(userId: string, role: string, memberType: string) {
  await db.insert(workspaceMembers).values({
    id: generateId('wm'),
    userId,
    email: `${userId}@test.dev`,
    role,
    memberType,
  });
}

async function installedApps(userId: string): Promise<string[]> {
  const { request } = createTestApp('/api/dashboard', dashboardRoutes, {
    context: { userId, tenantDb: db },
  });
  const res = await request('/api/dashboard/installed-apps');
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: string[] };
  return [...json.data].sort();
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  for (const appCode of ['weldcrm', 'weldchat', 'weldhr', 'weldbooks']) {
    await db.insert(workspaceInstalledApps).values({ id: generateId('wia'), appCode });
  }
  await seedMember('user_admin', 'ADMIN', 'INTERNAL');
  await seedMember('user_member', 'MEMBER', 'INTERNAL');
  await seedMember('user_employee', 'VIEWER', 'EMPLOYEE');
}, 60_000);

describe('GET /api/dashboard/installed-apps', () => {
  it('gives admins every installed app', async () => {
    expect(await installedApps('user_admin')).toEqual(['weldbooks', 'weldchat', 'weldcrm', 'weldhr']);
  });

  it('gives a member without a role or assignments nothing', async () => {
    expect(await installedApps('user_member')).toEqual([]);
  });

  it('gives an EMPLOYEE member WeldHR and WeldChat only', async () => {
    expect(await installedApps('user_employee')).toEqual(['weldchat', 'weldhr']);
  });
});
