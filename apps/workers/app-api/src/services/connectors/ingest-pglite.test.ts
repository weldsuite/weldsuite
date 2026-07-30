/**
 * pglite-backed tests for the connector ingest write path.
 *
 * Runs against a real PostgreSQL (WASM) with the tenant migrations applied, so
 * the dedup / checksum / mapping behaviour is exercised for real rather than
 * against a mock query builder. The atomicity path in particular only means
 * anything against a driver that actually has transactions.
 *
 * Tables in play: `accounting_contacts` and `integration_entity_mappings`. The
 * `connector_connections` bookkeeping lives in `connections.ts` and `sync.ts`
 * and is not touched here — this file covers what lands in the tenant's data.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getConnector, type ConnectorEntityDef, type ExternalEntity } from '@weldsuite/connectors';
import { ingestEntities, sanitiseErrorMessage } from './ingest';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

// Entity events fan out to queues and realtime, neither of which exists in a
// unit test. The ingest must not depend on their success.
vi.mock('@weldsuite/entity-events', () => ({
  publishEntityEventRaw: vi.fn().mockResolvedValue(undefined),
}));

let db: Database;

const CONNECTOR_ID = 'moneybird';
const CUSTOMER_ENTITY = getConnector(CONNECTOR_ID)!.entities.find(
  (e) => e.entity === 'customer',
) as ConnectorEntityDef;

/** Fresh connection id per test so mappings never bleed between cases. */
let connectionSeq = 0;
function nextConnectionId(): string {
  connectionSeq += 1;
  return `ccn_test_${connectionSeq}`;
}

/**
 * A Moneybird contact as the driver hands it over.
 *
 * The email is derived from the id rather than shared, because the tests run
 * against one pglite database: a constant address makes every case dedup onto the
 * first test's row, which silently turns `created` into `modified`.
 */
function contact(
  id: string,
  overrides: Record<string, unknown> = {},
  isDeleted = false,
): ExternalEntity {
  const data = {
    id,
    company_name: 'Acme BV',
    email: `${id}@acme.example`,
    phone: '+31 20 123 4567',
    address1: 'Keizersgracht 1',
    zipcode: '1015 CJ',
    city: 'Amsterdam',
    country: 'NL',
    tax_number: 'NL001234567B01',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
  return {
    id,
    type: 'customer',
    data,
    updatedAt: String(data.updated_at ?? '2026-07-01T00:00:00Z'),
    isDeleted,
    raw: data,
  };
}

function ingest(connectionId: string, entities: ExternalEntity[]) {
  return ingestEntities({
    db,
    connectionId,
    connectorId: CONNECTOR_ID,
    entityDef: CUSTOMER_ENTITY,
    entities,
    ownerId: 'user_test',
    workspaceId: 'org_test',
    env: {},
  });
}

function mappingFor(connectionId: string, externalId: string) {
  return db
    .select()
    .from(schema.integrationEntityMappings)
    .where(
      and(
        eq(schema.integrationEntityMappings.connectionId, connectionId),
        eq(schema.integrationEntityMappings.externalEntityType, CUSTOMER_ENTITY.externalEntityType),
        eq(schema.integrationEntityMappings.externalEntityId, externalId),
      ),
    )
    .limit(1);
}

function contactRow(id: string) {
  return db.select().from(schema.accountingContacts).where(eq(schema.accountingContacts.id, id)).limit(1);
}

// 60s, matching every other pglite suite here: applying the tenant migrations
// into a WASM Postgres takes well over the default 10s hook timeout once the
// full suite is running its files concurrently.
beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('ingestEntities — create', () => {
  it('creates the row and its mapping together', async () => {
    const connectionId = nextConnectionId();
    const result = await ingest(connectionId, [contact('mb-1')]);

    expect(result.created).toBe(1);
    expect(result.failed).toBe(0);

    const [mapping] = await mappingFor(connectionId, 'mb-1');
    expect(mapping).toBeDefined();
    expect(mapping?.syncChecksum).toMatch(/^[0-9a-f]{64}$/);

    const [row] = await contactRow(mapping!.internalEntityId);
    expect(row?.name).toBe('Acme BV');
    expect(row?.email).toBe('mb-1@acme.example');
    expect(row?.type).toBe('customer');
    expect(row?.taxNumber).toBe('NL001234567B01');
    expect(row?.billingAddress).toMatchObject({ city: 'Amsterdam', postalCode: '1015 CJ' });
  });

  it('names a private individual from first + last name', async () => {
    const connectionId = nextConnectionId();
    await ingest(connectionId, [
      contact('mb-2', {
        company_name: null,
        firstname: 'Jelle',
        lastname: 'de Vries',
        email: 'jelle@example.test',
      }),
    ]);

    const [mapping] = await mappingFor(connectionId, 'mb-2');
    const [row] = await contactRow(mapping!.internalEntityId);
    expect(row?.name).toBe('Jelle de Vries');
    expect(row?.firstName).toBe('Jelle');
  });

  it('falls back to the email when there is no name at all', async () => {
    const connectionId = nextConnectionId();
    await ingest(connectionId, [
      contact('mb-3', { company_name: null, firstname: null, lastname: null }),
    ]);

    const [mapping] = await mappingFor(connectionId, 'mb-3');
    const [row] = await contactRow(mapping!.internalEntityId);
    expect(row?.name).toBe('mb-3@acme.example');
  });

  it('skips a record with no usable identity instead of failing the page', async () => {
    const connectionId = nextConnectionId();
    const result = await ingest(connectionId, [
      contact('mb-4', { company_name: null, firstname: null, lastname: null, email: null }),
      contact('mb-5'),
    ]);

    expect(result.skipped).toBe(1);
    expect(result.created).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('takes only the first of several comma-separated emails', async () => {
    const connectionId = nextConnectionId();
    await ingest(connectionId, [
      contact('mb-6', { email: 'first@acme.example, second@acme.example' }),
    ]);

    const [mapping] = await mappingFor(connectionId, 'mb-6');
    const [row] = await contactRow(mapping!.internalEntityId);
    expect(row?.email).toBe('first@acme.example');
  });

  it('keeps only IBAN-shaped bank accounts', async () => {
    // Moneybird's `bank_account` is free text, and a non-IBAN value in an `iban`
    // column would break any SEPA export that trusts it. 'ask Jan in accounts'
    // strips to ASKJANINACCOUNTS, which a looser pattern accepts — the two check
    // digits are what reject it.
    const connectionId = nextConnectionId();
    await ingest(connectionId, [
      contact('mb-7', { bank_account: 'NL91 ABNA 0417 1643 00' }),
      contact('mb-8', { bank_account: 'ask Jan in accounts' }),
      contact('mb-9', { bank_account: 'rekening onbekend' }),
    ]);

    const [a] = await mappingFor(connectionId, 'mb-7');
    const [rowA] = await contactRow(a!.internalEntityId);
    expect(rowA?.iban).toBe('NL91ABNA0417164300');

    for (const externalId of ['mb-8', 'mb-9']) {
      const [mapping] = await mappingFor(connectionId, externalId);
      const [row] = await contactRow(mapping!.internalEntityId);
      expect(row?.iban).toBeNull();
    }
  });
});

describe('ingestEntities — re-delivery', () => {
  it('skips an unchanged record rather than rewriting it', async () => {
    const connectionId = nextConnectionId();
    await ingest(connectionId, [contact('mb-10')]);

    const [before] = await mappingFor(connectionId, 'mb-10');
    const [rowBefore] = await contactRow(before!.internalEntityId);

    const second = await ingest(connectionId, [contact('mb-10')]);

    expect(second.skipped).toBe(1);
    expect(second.modified).toBe(0);

    const [rowAfter] = await contactRow(before!.internalEntityId);
    // The row was genuinely untouched, not rewritten with identical values.
    expect(rowAfter?.updatedAt?.getTime()).toBe(rowBefore?.updatedAt?.getTime());
  });

  it('is insensitive to provider key order', async () => {
    const connectionId = nextConnectionId();
    await ingest(connectionId, [contact('mb-11')]);

    const reordered = contact('mb-11');
    reordered.data = Object.fromEntries(Object.entries(reordered.data).reverse());

    const second = await ingest(connectionId, [reordered]);
    expect(second.skipped).toBe(1);
  });

  it('updates the row and the checksum when a value changes', async () => {
    const connectionId = nextConnectionId();
    await ingest(connectionId, [contact('mb-12')]);
    const [before] = await mappingFor(connectionId, 'mb-12');

    const result = await ingest(connectionId, [contact('mb-12', { company_name: 'Acme Holding BV' })]);

    expect(result.modified).toBe(1);
    const [after] = await mappingFor(connectionId, 'mb-12');
    expect(after?.syncChecksum).not.toBe(before?.syncChecksum);

    const [row] = await contactRow(after!.internalEntityId);
    expect(row?.name).toBe('Acme Holding BV');
    // Same internal row — an update must never create a second one.
    expect(after?.internalEntityId).toBe(before?.internalEntityId);
  });
});

describe('ingestEntities — dedup', () => {
  it('links to an existing contact with the same email instead of duplicating', async () => {
    const existingId = 'acn_preexisting';
    await db.insert(schema.accountingContacts).values({
      id: existingId,
      type: 'customer',
      name: 'Acme (entered by hand)',
      email: 'dedup@acme.example',
    });

    const connectionId = nextConnectionId();
    const result = await ingest(connectionId, [
      contact('mb-20', { email: 'dedup@acme.example', company_name: 'Acme BV' }),
    ]);

    expect(result.modified).toBe(1);
    expect(result.created).toBe(0);

    const [mapping] = await mappingFor(connectionId, 'mb-20');
    expect(mapping?.internalEntityId).toBe(existingId);

    const [row] = await contactRow(existingId);
    // The provider's value wins on a linked row.
    expect(row?.name).toBe('Acme BV');
  });

  it('keeps mappings from different connections independent', async () => {
    const first = nextConnectionId();
    const second = nextConnectionId();

    await ingest(first, [contact('mb-shared')]);
    await ingest(second, [contact('mb-shared')]);

    const [a] = await mappingFor(first, 'mb-shared');
    const [b] = await mappingFor(second, 'mb-shared');

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a?.id).not.toBe(b?.id);
    // Same email, so the second connection dedups onto the same internal row
    // rather than importing a duplicate.
    expect(a?.internalEntityId).toBe(b?.internalEntityId);
  });
});

describe('ingestEntities — delete and undelete', () => {
  it('soft-deletes the row, keeps the mapping, and clears the checksum', async () => {
    const connectionId = nextConnectionId();
    await ingest(connectionId, [contact('mb-30')]);
    const [mapping] = await mappingFor(connectionId, 'mb-30');

    const result = await ingest(connectionId, [contact('mb-30', {}, true)]);
    expect(result.deleted).toBe(1);

    const [row] = await contactRow(mapping!.internalEntityId);
    expect(row?.deletedAt).not.toBeNull();

    const [after] = await mappingFor(connectionId, 'mb-30');
    // The mapping survives so an undelete re-links; the cleared checksum is what
    // makes the next delivery take the update path instead of skipping.
    expect(after).toBeDefined();
    expect(after?.syncChecksum).toBeNull();
  });

  it('resurrects the same row when the record comes back', async () => {
    const connectionId = nextConnectionId();
    await ingest(connectionId, [contact('mb-31')]);
    const [original] = await mappingFor(connectionId, 'mb-31');

    await ingest(connectionId, [contact('mb-31', {}, true)]);
    const result = await ingest(connectionId, [contact('mb-31')]);

    expect(result.modified).toBe(1);
    expect(result.created).toBe(0);

    const [after] = await mappingFor(connectionId, 'mb-31');
    expect(after?.internalEntityId).toBe(original?.internalEntityId);

    const [row] = await contactRow(original!.internalEntityId);
    expect(row?.deletedAt).toBeNull();
  });

  it('skips a delete for a record it never imported', async () => {
    const connectionId = nextConnectionId();
    const result = await ingest(connectionId, [contact('mb-never-seen', {}, true)]);
    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

describe('sanitiseErrorMessage', () => {
  it('redacts the value out of a Postgres key conflict', () => {
    // These strings land on the run row and are rendered in the UI, so the column
    // name is the useful part and the value is the tenant's contact data.
    const message = sanitiseErrorMessage(
      new Error('duplicate key value violates unique constraint: Key (email)=(jelle@acme.example) already exists'),
    );
    expect(message).toContain('(email)=(redacted)');
    expect(message).not.toContain('jelle@acme.example');
  });

  it('redacts quoted literals', () => {
    expect(sanitiseErrorMessage(new Error("invalid input value for enum: 'Acme BV'"))).not.toContain(
      'Acme BV',
    );
  });

  it('truncates long messages', () => {
    expect(sanitiseErrorMessage(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(200);
  });

  it('handles a non-Error throw', () => {
    expect(sanitiseErrorMessage('plain string')).toBe('plain string');
  });
});
