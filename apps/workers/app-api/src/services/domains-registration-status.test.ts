/**
 * Registration-status mapping used by the purchase success page.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
import { getRegistrationStatus } from './domains';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

async function insertDomain(values: {
  fullDomain: string;
  status: 'active' | 'pending' | 'cancelled';
  registrationStatus:
    | 'pending_payment'
    | 'pending_registration'
    | 'pending_workflow'
    | 'registered'
    | 'registration_failed'
    | null;
  metadata?: Record<string, unknown>;
}) {
  const id = generateId('dom');
  const parts = values.fullDomain.split('.');
  await db.insert(schema.hostDomains).values({
    id,
    name: parts[0]!,
    tld: parts.slice(1).join('.'),
    fullDomain: values.fullDomain,
    status: values.status,
    registrationStatus: values.registrationStatus,
    metadata: values.metadata,
  });
  return id;
}

describe('getRegistrationStatus', () => {
  it('maps registered + active to the success-page completed shape', async () => {
    const id = await insertDomain({
      fullDomain: 'done.example',
      status: 'active',
      registrationStatus: 'registered',
    });
    await expect(getRegistrationStatus(db, id)).resolves.toMatchObject({
      registrationId: id,
      domainId: id,
      domainName: 'done.example',
      status: 'completed',
    });
  });

  it('maps pending_workflow to registering', async () => {
    const id = await insertDomain({
      fullDomain: 'async.example',
      status: 'pending',
      registrationStatus: 'pending_workflow',
    });
    await expect(getRegistrationStatus(db, id)).resolves.toMatchObject({
      status: 'registering',
      domainId: null,
      domainName: 'async.example',
    });
  });

  it('surfaces the registrar error on a failed registration', async () => {
    const id = await insertDomain({
      fullDomain: 'fail.example',
      status: 'cancelled',
      registrationStatus: 'registration_failed',
      metadata: { error: 'TLD rejected the contact' },
    });
    await expect(getRegistrationStatus(db, id)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'TLD rejected the contact',
    });
  });
});
