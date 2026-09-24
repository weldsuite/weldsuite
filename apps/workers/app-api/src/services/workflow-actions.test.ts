import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';
import { createCustomerFromWorkflow, DEFAULT_WORKFLOW_CUSTOMER_STATUS } from './workflow-actions';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('createCustomerFromWorkflow', () => {
  it('creates a CRM company through the companies service', async () => {
    const { created, company } = await createCustomerFromWorkflow(db, {
      name: 'Acme Workflows',
      email: 'hello@acme-workflows.test',
      userId: 'user_1',
      skipIfEmailExists: true,
    });

    expect(created).toBe(true);
    expect(company).toMatchObject({
      name: 'Acme Workflows',
      displayName: 'Acme Workflows',
      email: 'hello@acme-workflows.test',
      status: DEFAULT_WORKFLOW_CUSTOMER_STATUS,
      source: 'weldconnect',
      ownerId: 'user_1',
    });
    const [row] = await db.select().from(schema.companies).where(eq(schema.companies.id, company.id));
    expect(row?.deletedAt).toBeNull();
  });

  it('reuses an existing company with the same email (case-insensitive)', async () => {
    const first = await createCustomerFromWorkflow(db, {
      name: 'Dup Co',
      email: 'Team@Dup.test',
      userId: 'user_1',
      skipIfEmailExists: true,
    });
    const second = await createCustomerFromWorkflow(db, {
      name: 'Dup Co again',
      email: 'team@dup.test',
      userId: 'user_1',
      skipIfEmailExists: true,
    });

    expect(second.created).toBe(false);
    expect(second.company.id).toBe(first.company.id);
  });

  it('creates a duplicate when de-duplication is off', async () => {
    const first = await createCustomerFromWorkflow(db, {
      name: 'Twice',
      email: 'twice@dup.test',
      userId: 'user_1',
      skipIfEmailExists: false,
    });
    const second = await createCustomerFromWorkflow(db, {
      name: 'Twice',
      email: 'twice@dup.test',
      userId: 'user_1',
      skipIfEmailExists: false,
    });
    expect(second.created).toBe(true);
    expect(second.company.id).not.toBe(first.company.id);
  });

  it('honours an explicit status and leaves the owner unset for schedule runs', async () => {
    const { company } = await createCustomerFromWorkflow(db, {
      name: 'Nightly import',
      status: 'prospect',
      userId: 'system',
      skipIfEmailExists: true,
    });
    expect(company.status).toBe('prospect');
    expect(company.ownerId).toBeNull();
  });
});
