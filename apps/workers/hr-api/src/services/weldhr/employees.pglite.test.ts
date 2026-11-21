/**
 * Service tests for employee ↔ workspace-member linking. Every new employee
 * is an INTERNAL or EMPLOYEE member of the workspace, or about to be one: an
 * employee added while their invite is pending is linked once they accept.
 * Pictures come from the member's account (master `users`), never from the
 * workspace member row.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '@weldsuite/db/schema/master';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const holder = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => holder.master,
}));

import {
  createEmployee,
  createEmployeeFromMember,
  employeeForUser,
  linkAcceptedInvites,
  listAvailableMembers,
  updateEmployee,
} from './employees';
import { HrConflictError, HrNotFoundError, HrValidationError } from './shared';

const ENV = { DATABASE_URL_MASTER: 'postgres://test' };
const ALICE_PICTURE = 'https://img.clerk.test/alice.png';
const FAY_PICTURE = 'https://img.clerk.test/fay.png';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
  const master: any = (await createMasterPgliteDb()).db;
  holder.master = master;
  await master
    .insert(users)
    .values([
      { id: 'user_alice', email: 'alice@example.com', imageUrl: ALICE_PICTURE },
      { id: 'user_fay', email: 'fay@example.com', imageUrl: FAY_PICTURE },
    ])
    .onConflictDoNothing();

  await db.insert(schema.workspaceMembers).values([
    {
      id: 'wm_user_alice',
      userId: 'user_alice',
      name: 'Alice Example',
      email: 'alice@example.com',
      // A stale per-workspace copy: the employee takes the account picture.
      picture: 'https://stale.test/alice.png',
      title: 'Engineer',
      phone: '+32000000001',
      status: 'ACTIVE',
      memberType: 'INTERNAL',
    },
    {
      id: 'wm_user_bob',
      userId: 'user_bob',
      name: 'Bob Example',
      email: 'bob@example.com',
      status: 'ACTIVE',
      memberType: 'INTERNAL',
    },
    {
      id: 'wm_user_pending',
      userId: 'invited_pending@example.com',
      name: 'Pending Person',
      email: 'pending@example.com',
      status: 'PENDING',
      memberType: 'INTERNAL',
    },
    {
      id: 'wm_user_erin',
      userId: 'user_erin',
      name: 'Erin Employee',
      email: 'erin@example.com',
      status: 'ACTIVE',
      memberType: 'EMPLOYEE',
    },
    {
      id: 'wm_user_gus',
      userId: 'user_gus',
      name: 'Gus Guest',
      email: 'gus@example.com',
      status: 'ACTIVE',
      memberType: 'EXTERNAL_GUEST',
    },
  ]);
}, 60_000);

describe('createEmployeeFromMember', () => {
  it('prefills from the workspace member and links userId', async () => {
    const row = await createEmployeeFromMember(
      db,
      { userId: 'user_alice' },
      { env: ENV, createdBy: 'user_hr' },
    );
    expect(row.userId).toBe('user_alice');
    expect(row.firstName).toBe('Alice');
    expect(row.lastName).toBe('Example');
    expect(row.email).toBe('alice@example.com');
    expect(row.jobTitle).toBe('Engineer');
    expect(row.phone).toBe('+32000000001');
    expect(row.avatarUrl).toBe(ALICE_PICTURE);
  });

  it('rejects a second employee for the same member', async () => {
    await expect(
      createEmployeeFromMember(db, { userId: 'user_alice' }, { env: ENV, createdBy: 'user_hr' }),
    ).rejects.toBeInstanceOf(HrConflictError);
  });

  it('rejects pending invite placeholders', async () => {
    await expect(
      createEmployeeFromMember(
        db,
        { userId: 'invited_pending@example.com' },
        { env: ENV, createdBy: 'user_hr' },
      ),
    ).rejects.toBeInstanceOf(HrValidationError);
  });

  it('rejects unknown members', async () => {
    await expect(
      createEmployeeFromMember(db, { userId: 'user_missing' }, { env: ENV, createdBy: 'user_hr' }),
    ).rejects.toBeInstanceOf(HrNotFoundError);
  });
});

describe('createEmployee · userId', () => {
  it('requires a workspace member', async () => {
    await expect(
      createEmployee(
        db,
        { firstName: 'No', lastName: 'Member', email: 'nomember@example.com', userId: '' },
        { createdBy: 'user_hr' },
      ),
    ).rejects.toBeInstanceOf(HrValidationError);
  });

  it('rejects external guests', async () => {
    await expect(
      createEmployeeFromMember(db, { userId: 'user_gus' }, { env: ENV, createdBy: 'user_hr' }),
    ).rejects.toBeInstanceOf(HrValidationError);
  });

  it('accepts EMPLOYEE members', async () => {
    const row = await createEmployeeFromMember(db, { userId: 'user_erin' }, { env: ENV, createdBy: 'user_hr' });
    expect(row.userId).toBe('user_erin');
    expect(row.email).toBe('erin@example.com');
  });

  it('links an active member once', async () => {
    const row = await createEmployee(
      db,
      {
        firstName: 'Bob',
        lastName: 'Example',
        email: 'bob.employee@example.com',
        userId: 'user_bob',
      },
      { createdBy: 'user_hr' },
    );
    expect(row.userId).toBe('user_bob');
  });

  it('rejects linking a userId that is already used', async () => {
    await expect(
      createEmployee(
        db,
        {
          firstName: 'Other',
          lastName: 'Person',
          email: 'other@example.com',
          userId: 'user_bob',
        },
        { createdBy: 'user_hr' },
      ),
    ).rejects.toBeInstanceOf(HrConflictError);
  });
});

describe('updateEmployee · userId', () => {
  it('can link an unlinked (pre-existing) employee to a free member', async () => {
    // Employees created before every employee had to be a member have no userId.
    await db.insert(schema.hrEmployees).values({
      id: 'hremp_legacy_carol',
      firstName: 'Carol',
      lastName: 'Free',
      email: 'carol@example.com',
    });
    await db.insert(schema.workspaceMembers).values({
      id: 'wm_user_carol',
      userId: 'user_carol',
      name: 'Carol Free',
      email: 'carol.member@example.com',
      status: 'ACTIVE',
      memberType: 'INTERNAL',
    });

    const updated = await updateEmployee(db, 'hremp_legacy_carol', { userId: 'user_carol' });
    expect(updated.userId).toBe('user_carol');
  });

  it('refuses to unlink an employee from their member', async () => {
    await expect(updateEmployee(db, 'hremp_legacy_carol', { userId: null })).rejects.toBeInstanceOf(
      HrValidationError,
    );
  });

  it('still edits other fields of a legacy employee without a member', async () => {
    await db.insert(schema.hrEmployees).values({
      id: 'hremp_legacy_dan',
      firstName: 'Dan',
      lastName: 'Legacy',
      email: 'dan@example.com',
    });
    const updated = await updateEmployee(db, 'hremp_legacy_dan', { jobTitle: 'Analyst' });
    expect(updated.jobTitle).toBe('Analyst');
    expect(updated.userId).toBeNull();
  });
});

describe('listAvailableMembers', () => {
  it('lists active INTERNAL and EMPLOYEE members that are not linked yet', async () => {
    await db.insert(schema.workspaceMembers).values([
      {
        id: 'wm_user_fay',
        userId: 'user_fay',
        name: 'Fay Free',
        email: 'fay@example.com',
        status: 'ACTIVE',
        memberType: 'EMPLOYEE',
      },
      {
        id: 'wm_user_hal',
        userId: 'user_hal',
        name: 'Hal Free',
        email: 'hal@example.com',
        status: 'ACTIVE',
        memberType: 'INTERNAL',
      },
    ]);

    const userIds = (await listAvailableMembers(ENV, db)).map((m) => m.userId);
    expect(userIds).toEqual(expect.arrayContaining(['user_fay', 'user_hal']));
    // Linked already (alice, bob, erin, carol), a pending invite, and a guest.
    for (const excluded of ['user_alice', 'user_bob', 'user_erin', 'user_carol', 'invited_pending@example.com', 'user_gus']) {
      expect(userIds).not.toContain(excluded);
    }
  });

  it('filters by name or email', async () => {
    const rows = await listAvailableMembers(ENV, db, { search: 'fay@' });
    expect(rows.map((m) => m.userId)).toEqual(['user_fay']);
    expect(rows[0]?.memberType).toBe('EMPLOYEE');
  });

  it('gives each member their account picture, null without one', async () => {
    const rows = await listAvailableMembers(ENV, db);
    const pictures = Object.fromEntries(rows.map((m) => [m.userId, m.picture]));
    expect(pictures.user_fay).toBe(FAY_PICTURE);
    expect(pictures.user_hal).toBeNull();
  });
});

describe('employeeForUser', () => {
  it('finds the member’s own employee and hides terminated ones', async () => {
    const own = await employeeForUser(db, 'user_erin');
    expect(own?.userId).toBe('user_erin');

    await updateEmployee(db, own!.id, { status: 'terminated' });
    expect(await employeeForUser(db, 'user_erin')).toBeNull();
    expect(await employeeForUser(db, 'user_nobody')).toBeNull();
  });
});

describe('createEmployee by email · invited people', () => {
  beforeAll(async () => {
    await db.insert(schema.workspaceMembers).values([
      // Invited from WeldHR, not accepted yet.
      { id: 'wm_ivy', userId: 'invited_ivy@example.com', name: 'Ivy Invited', email: 'ivy@example.com', status: 'PENDING', memberType: 'EMPLOYEE' },
      { id: 'wm_jo', userId: 'user_jo', name: 'Jo Active', email: 'jo@example.com', status: 'ACTIVE', memberType: 'INTERNAL' },
      { id: 'wm_kim', userId: 'invited_kim@example.com', name: 'Kim Guest', email: 'kim@example.com', status: 'PENDING', memberType: 'EXTERNAL_GUEST' },
    ]);
  });

  it('adds someone whose invite is pending, unlinked', async () => {
    const row = await createEmployee(db, { firstName: 'Ivy', lastName: 'Invited', email: 'IVY@example.com' }, { createdBy: 'user_hr' });
    expect(row.userId).toBeNull();
  });

  it('links an active member with that email right away', async () => {
    const row = await createEmployee(db, { firstName: 'Jo', lastName: 'Active', email: 'jo@example.com' }, { createdBy: 'user_hr' });
    expect(row.userId).toBe('user_jo');
  });

  it('refuses people who are not (being) members, and guests', async () => {
    await expect(
      createEmployee(db, { firstName: 'Lee', lastName: 'Stranger', email: 'lee@example.com' }, { createdBy: 'user_hr' }),
    ).rejects.toBeInstanceOf(HrValidationError);
    await expect(
      createEmployee(db, { firstName: 'Kim', lastName: 'Guest', email: 'kim@example.com' }, { createdBy: 'user_hr' }),
    ).rejects.toBeInstanceOf(HrValidationError);
  });

  it('links the employee once the invite is accepted, and only once', async () => {
    expect(await linkAcceptedInvites(db, { userId: 'user_ivy' })).toEqual([]);

    // Accepting swaps the placeholder for the Clerk id on the same member row.
    await db
      .update(schema.workspaceMembers)
      .set({ userId: 'user_ivy', status: 'ACTIVE' })
      .where(eq(schema.workspaceMembers.id, 'wm_ivy'));

    const linked = await linkAcceptedInvites(db, { userId: 'user_ivy' });
    expect(linked).toHaveLength(1);
    expect((await employeeForUser(db, 'user_ivy'))?.email).toBe('IVY@example.com');
    expect(await linkAcceptedInvites(db, {})).toEqual([]);
  });

  it('never links a member who already has an employee', async () => {
    // A legacy employee carrying Jo's email, while Jo is already linked above.
    await db.insert(schema.hrEmployees).values({ id: 'hremp_legacy_jo', firstName: 'Jo', lastName: 'Old', email: 'jo@example.com' });
    expect(await linkAcceptedInvites(db, { employeeId: 'hremp_legacy_jo' })).toEqual([]);
  });
});
