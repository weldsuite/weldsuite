/**
 * Incoming transfers must register on WeldSuite-owned RTR contacts so the
 * TLD / Realtime Register never email the customer.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';
import type { RealtimeRegistrar } from '@weldsuite/realtime-registrar';
import { createDomainTransfer } from './domain-transfers';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('createDomainTransfer · platform contacts', () => {
  it('sends only platform handles to RTR even when a customer contact is provided', async () => {
    const ensure = vi.fn();
    const transfer = vi.fn(async (_payload: Record<string, unknown>) => ({
      status: 'pending',
      processId: 99,
      domainName: 'platform-contacts-in.example',
      type: 'IN' as const,
    }));
    const rtr = {
      ensureRegistrantFromDomainContact: ensure,
      transfer,
    } as unknown as RealtimeRegistrar;

    const row = await createDomainTransfer(
      db,
      {
        domainName: 'platform-contacts-in.example',
        type: 'incoming',
        authCode: 'EPPCODE',
      },
      {
        rtr,
        contactEnv: {
          REALTIME_REGISTER_CONTACT_ADMIN: 'ws-admin',
          REALTIME_REGISTER_CONTACT_TECH: 'ws-tech',
          REALTIME_REGISTER_CONTACT_BILLING: 'ws-billing',
        },
        registrantContact: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@customer.example',
          phone: '+44.2079460958',
          address1: '1 Street',
          city: 'London',
          postalCode: 'SW1A 1AA',
          country: 'GB',
        },
      },
    );

    expect(ensure).not.toHaveBeenCalled();
    expect(transfer).toHaveBeenCalledTimes(1);
    const payload = transfer.mock.calls[0]![0];
    expect(payload).toEqual({
      name: 'platform-contacts-in.example',
      registrant: 'ws-admin',
      authCode: 'EPPCODE',
      contacts: [
        { role: 'ADMIN', handle: 'ws-admin' },
        { role: 'TECH', handle: 'ws-tech' },
        { role: 'BILLING', handle: 'ws-billing' },
      ],
      nameservers: undefined,
      privacyProtect: true,
      designatedAgent: 'NONE',
      periodMonths: 12,
    });
    expect(payload).not.toHaveProperty('registrantContact');
    expect(JSON.stringify(payload)).not.toContain('ada@customer.example');
    expect(JSON.stringify(payload)).not.toContain('Ada');

    expect(row.domainId).toBeTruthy();
    const [domain] = await db
      .select()
      .from(schema.hostDomains)
      .where(eq(schema.hostDomains.id, row.domainId!))
      .limit(1);
    expect(domain?.rtrRegistrantHandle).toBe('ws-admin');
    expect(domain?.privacyProtection).toBe(true);
    expect(domain?.registrantContact).toMatchObject({ email: 'ada@customer.example' });
  });

  it('fails the transfer when REALTIME_REGISTER_CONTACT_ADMIN is unset', async () => {
    const transfer = vi.fn();
    const rtr = { transfer } as unknown as RealtimeRegistrar;

    await expect(
      createDomainTransfer(
        db,
        { domainName: 'missing-admin.example', type: 'incoming', authCode: 'EPP' },
        { rtr, contactEnv: {} },
      ),
    ).rejects.toThrow(/REALTIME_REGISTER_CONTACT_ADMIN/);
    expect(transfer).not.toHaveBeenCalled();
  });
});
