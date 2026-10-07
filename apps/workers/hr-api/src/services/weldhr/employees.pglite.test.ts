/**
 * Service tests for employee ↔ workspace-member linking.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createEmployee, createEmployeeFromMember, updateEmployee } from './employees';
import { HrConflictError, HrNotFoundError, HrValidationError } from './shared';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;

  await db.insert(schema.workspaceMembers).values([
    {
      id: 'wm_user_alice',
      userId: 'user_alice',
      name: 'Alice Example',
      email: 'alice@example.com',
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
  ]);
}, 60_000);

describe('createEmployeeFromMember', () => {
  it('prefills from the workspace member and links userId', async () => {
    const row = await createEmployeeFromMember(
      db,
      { userId: 'user_alice' },
      { createdBy: 'user_hr' },
    );
    expect(row.userId).toBe('user_alice');
    expect(row.firstName).toBe('Alice');
    expect(row.lastName).toBe('Example');
    expect(row.email).toBe('alice@example.com');
    expect(row.jobTitle).toBe('Engineer');
    expect(row.phone).toBe('+32000000001');
  });

  it('rejects a second employee for the same member', async () => {
    await expect(
      createEmployeeFromMember(db, { userId: 'user_alice' }, { createdBy: 'user_hr' }),
    ).rejects.toBeInstanceOf(HrConflictError);
  });

  it('rejects pending invite placeholders', async () => {
    await expect(
      createEmployeeFromMember(
        db,
        { userId: 'invited_pending@example.com' },
        { createdBy: 'user_hr' },
      ),
    ).rejects.toBeInstanceOf(HrValidationError);
  });

  it('rejects unknown members', async () => {
    await expect(
      createEmployeeFromMember(db, { userId: 'user_missing' }, { createdBy: 'user_hr' }),
    ).rejects.toBeInstanceOf(HrNotFoundError);
  });
});

describe('createEmployee · userId', () => {
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
  it('can link an unlinked employee to a free member', async () => {
    const created = await createEmployee(
      db,
      {
        firstName: 'Carol',
        lastName: 'Free',
        email: 'carol@example.com',
      },
      { createdBy: 'user_hr' },
    );

    // Seed a fresh member only for this case.
    await db.insert(schema.workspaceMembers).values({
      id: 'wm_user_carol',
      userId: 'user_carol',
      name: 'Carol Free',
      email: 'carol.member@example.com',
      status: 'ACTIVE',
      memberType: 'INTERNAL',
    });

    const updated = await updateEmployee(db, created.id, { userId: 'user_carol' });
    expect(updated.userId).toBe('user_carol');
  });
});
