/**
 * A project member's avatar is their account picture (`users.image_url` in the
 * master database), never the per-workspace copy in `workspace_members.picture`:
 * the member list, the by-user read and the "available" picker all answer the
 * account picture, and null for someone without an account or a picture.
 *
 * Runs against the TypeScript worker and, in conformance mode, the Rust backend
 * (the master database is shared with it through `masterDb`).
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { users } from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const holder = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
}));

import type { Env, Variables } from '../../types';
import { projectMembersRoutes } from './index';

const router = new Hono<{ Bindings: Env; Variables: Variables }>();
router.route('/project-members', projectMembersRoutes);

const PROJECT = 'prj_av_one';
const OWNER = 'user_av_owner';
const MEMBER = 'user_av_member';
const SPARE = 'user_av_spare';
const NO_ACCOUNT = 'user_av_noaccount';

const OWNER_PICTURE = 'https://img.clerk.test/owner.png';
const SPARE_PICTURE = 'https://img.clerk.test/spare.png';
const STALE = 'https://stale.test/member-row.png';

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

function get(path: string) {
  const { request } = createTestApp('/api', router, {
    context: { userId: OWNER, permissions: permissions('projects:read'), tenantDb: db, masterDb: master },
  });
  return request(`/api${path}`);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;

  const created = new Date('2026-03-01T10:00:00.000Z');
  await master.insert(users).values([
    { id: OWNER, email: 'olga@example.com', imageUrl: OWNER_PICTURE },
    { id: MEMBER, email: 'mo@example.com', imageUrl: null },
    { id: SPARE, email: 'sid@example.com', imageUrl: SPARE_PICTURE },
  ]).onConflictDoNothing();

  await db.insert(schema.projects).values({
    id: PROJECT,
    name: 'Avatar Alpha',
    projectManagerId: OWNER,
    createdAt: created,
    updatedAt: created,
  });
  // Every member row carries a stale picture: none of it may reach a response.
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_av_owner', userId: OWNER, name: 'Olga Owner', email: 'olga@example.com', picture: STALE, status: 'ACTIVE' },
    { id: 'wm_av_member', userId: MEMBER, name: 'Mo Member', email: 'mo@example.com', picture: STALE, status: 'ACTIVE' },
    { id: 'wm_av_spare', userId: SPARE, name: 'Sid Spare', email: 'sid@example.com', picture: STALE, status: 'ACTIVE' },
    { id: 'wm_av_noacct', userId: NO_ACCOUNT, name: 'Nia None', email: 'nia@example.com', picture: STALE, status: 'ACTIVE' },
  ]);
  await db.insert(schema.projectMembers).values([
    { id: 'pm_av_owner', projectId: PROJECT, userId: OWNER, role: 'owner', isActive: true, createdAt: created, updatedAt: created, joinedAt: created },
    { id: 'pm_av_member', projectId: PROJECT, userId: MEMBER, role: 'member', isActive: true, createdAt: created, updatedAt: created, joinedAt: created },
  ]);
}, 60_000);

describe('project member avatars come from the account', () => {
  it('lists members with their account picture, null when the account has none', async () => {
    const res = await get(`/project-members?projectId=${PROJECT}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ userId: string; user: { avatar: string | null } | null }> };
    const avatars = Object.fromEntries(body.data.map((row) => [row.userId, row.user?.avatar]));
    expect(avatars).toEqual({ [OWNER]: OWNER_PICTURE, [MEMBER]: null });
  });

  it('reads one member by user id with their account picture', async () => {
    const res = await get(`/project-members/by-user/${PROJECT}/${OWNER}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { user: { id: string; name: string; avatar: string | null } } };
    expect(body.data.user).toEqual({ id: OWNER, name: 'Olga Owner', email: 'olga@example.com', avatar: OWNER_PICTURE });
  });

  it('offers available users with their account picture, null without an account', async () => {
    const res = await get(`/project-members/available?projectId=${PROJECT}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; image: string | null }> };
    const images = Object.fromEntries(body.data.map((row) => [row.id, row.image]));
    expect(images).toEqual({ [SPARE]: SPARE_PICTURE, [NO_ACCOUNT]: null });
  });
});
