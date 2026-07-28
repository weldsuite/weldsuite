/**
 * pglite-backed tests for the Nango ingest write path.
 *
 * Runs against a real PostgreSQL (WASM) with the tenant migrations applied, so
 * the dedup / checksum / mapping behaviour is exercised for real rather than
 * against a mock query builder.
 *
 * Note the tables in play: ingest writes only to `companies`, `people`,
 * `crm_opportunities`, `person_companies` and `integration_entity_mappings`.
 * The `nango_connections` bookkeeping lives in `connections.ts` and is not
 * touched here — this file covers what lands in the customer's CRM.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getConnector } from '@weldsuite/nango';
import type { ConnectorDef, ConnectorSyncDef } from '@weldsuite/nango';
import { ingestRecords, recordChecksum, resolveSync } from './ingest';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

// Entity events fan out to queues and realtime, neither of which exists in a
// unit test. The ingest must not depend on their success.
vi.mock('@weldsuite/entity-events', () => ({
  publishEntityEventRaw: vi.fn().mockResolvedValue(undefined),
}));

let db: Database;

const CONNECTOR = getConnector('hubspot') as ConnectorDef;
const COMPANY_SYNC = CONNECTOR.syncs.find((s) => s.internalEntity === 'company') as ConnectorSyncDef;
const PERSON_SYNC = CONNECTOR.syncs.find((s) => s.internalEntity === 'person') as ConnectorSyncDef;
const DEAL_SYNC = CONNECTOR.syncs.find((s) => s.internalEntity === 'opportunity') as ConnectorSyncDef;

/** Fresh connection id per test so mappings never bleed between cases. */
let connectionSeq = 0;
function nextConnectionId(): string {
  connectionSeq += 1;
  return `nconn_test_${connectionSeq}`;
}

function ingest(connectionId: string, sync: ConnectorSyncDef, records: Array<Record<string, unknown>>) {
  return ingestRecords({
    db,
    connectionId,
    connector: CONNECTOR,
    sync,
    records,
    ownerId: 'user_test',
    workspaceId: 'org_test',
    env: {},
  });
}

function meta(overrides: Record<string, unknown> = {}) {
  return {
    _nango_metadata: {
      first_seen_at: '2026-07-01T00:00:00Z',
      last_modified_at: '2026-07-01T00:00:00Z',
      last_action: 'ADDED',
      deleted_at: null,
      cursor: 'c1',
      ...overrides,
    },
  };
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('recordChecksum', () => {
  it('ignores the Nango envelope so re-delivery is a no-op', async () => {
    const a = await recordChecksum({ id: '1', name: 'Acme', ...meta() });
    const b = await recordChecksum({ id: '1', name: 'Acme', ...meta({ cursor: 'c9', last_action: 'UPDATED' }) });
    expect(a).toBe(b);
  });

  it('changes when the payload changes', async () => {
    const a = await recordChecksum({ id: '1', name: 'Acme' });
    const b = await recordChecksum({ id: '1', name: 'Acme Industrial' });
    expect(a).not.toBe(b);
  });

  it('sees changes nested inside provider property bags', async () => {
    const a = await recordChecksum({ id: '1', properties: { name: 'Before' } });
    const b = await recordChecksum({ id: '1', properties: { name: 'After' } });
    expect(a).not.toBe(b);
  });

  it('is stable across key ordering so a re-delivery is not a false update', async () => {
    const a = await recordChecksum({ id: '1', properties: { name: 'Acme', domain: 'a.example' } });
    const b = await recordChecksum({ properties: { domain: 'a.example', name: 'Acme' }, id: '1' });
    expect(a).toBe(b);
  });
});

describe('resolveSync', () => {
  it('resolves the (integration, model) pair a webhook carries', () => {
    expect(resolveSync('hubspot', 'HubspotCompany')?.sync.internalEntity).toBe('company');
  });

  it('returns null for models we have no mapper for', () => {
    expect(resolveSync('hubspot', 'HubspotTicket')).toBeNull();
    expect(resolveSync('zendesk', 'Ticket')).toBeNull();
  });
});

describe('ingestRecords · companies', () => {
  it('creates a company and records the external mapping', async () => {
    const connectionId = nextConnectionId();
    const result = await ingest(connectionId, COMPANY_SYNC, [
      { id: 'hs-1', properties: { name: 'Acme Industrial', domain: 'acme.example' }, ...meta() },
    ]);

    expect(result).toMatchObject({ created: 1, modified: 0, skipped: 0, failed: 0 });

    const [mapping] = await db
      .select()
      .from(schema.integrationEntityMappings)
      .where(
        and(
          eq(schema.integrationEntityMappings.connectionId, connectionId),
          eq(schema.integrationEntityMappings.externalEntityId, 'hs-1'),
        ),
      );
    expect(mapping?.internalEntityType).toBe('company');

    const [company] = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, mapping!.internalEntityId));
    expect(company).toMatchObject({ name: 'Acme Industrial', displayName: 'Acme Industrial' });
  });

  it('skips an unchanged record on re-delivery instead of rewriting it', async () => {
    const connectionId = nextConnectionId();
    const record = { id: 'hs-2', properties: { name: 'Steady BV' }, ...meta() };

    await ingest(connectionId, COMPANY_SYNC, [record]);
    const second = await ingest(connectionId, COMPANY_SYNC, [record]);

    expect(second).toMatchObject({ created: 0, modified: 0, skipped: 1 });
  });

  it('updates the same row when the record changes', async () => {
    const connectionId = nextConnectionId();
    await ingest(connectionId, COMPANY_SYNC, [{ id: 'hs-3', properties: { name: 'Before' }, ...meta() }]);
    const second = await ingest(connectionId, COMPANY_SYNC, [
      { id: 'hs-3', properties: { name: 'After' }, ...meta({ last_action: 'UPDATED' }) },
    ]);

    expect(second).toMatchObject({ created: 0, modified: 1 });

    const rows = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.name, 'After'));
    expect(rows).toHaveLength(1);
  });

  it('links to an existing company by email rather than creating a duplicate', async () => {
    const connectionId = nextConnectionId();
    const email = `dedupe-${Date.now()}@acme.example`;
    await db.insert(schema.companies).values({
      id: 'comp_existing_dedupe',
      name: 'Existing Acme',
      displayName: 'Existing Acme',
      email,
    });

    const result = await ingest(connectionId, COMPANY_SYNC, [
      { id: 'hs-4', name: 'Acme From HubSpot', email, ...meta() },
    ]);

    expect(result).toMatchObject({ created: 0, modified: 1 });

    const [mapping] = await db
      .select()
      .from(schema.integrationEntityMappings)
      .where(
        and(
          eq(schema.integrationEntityMappings.connectionId, connectionId),
          eq(schema.integrationEntityMappings.externalEntityId, 'hs-4'),
        ),
      );
    expect(mapping?.internalEntityId).toBe('comp_existing_dedupe');
  });

  it('soft-deletes the internal row when the external record is deleted', async () => {
    const connectionId = nextConnectionId();
    await ingest(connectionId, COMPANY_SYNC, [{ id: 'hs-5', name: 'Doomed BV', ...meta() }]);
    const result = await ingest(connectionId, COMPANY_SYNC, [
      { id: 'hs-5', name: 'Doomed BV', ...meta({ last_action: 'DELETED', deleted_at: '2026-07-02T00:00:00Z' }) },
    ]);

    expect(result).toMatchObject({ deleted: 1 });

    const [mapping] = await db
      .select()
      .from(schema.integrationEntityMappings)
      .where(
        and(
          eq(schema.integrationEntityMappings.connectionId, connectionId),
          eq(schema.integrationEntityMappings.externalEntityId, 'hs-5'),
        ),
      );
    // The mapping survives so a provider undelete re-links instead of duplicating.
    expect(mapping).toBeDefined();

    const [company] = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, mapping!.internalEntityId));
    expect(company?.deletedAt).toBeInstanceOf(Date);
  });

  it('counts an unmappable record as skipped without failing the page', async () => {
    const connectionId = nextConnectionId();
    const result = await ingest(connectionId, COMPANY_SYNC, [
      { id: 'hs-6', properties: {}, ...meta() },
      { name: 'No id at all', ...meta() },
      { id: 'hs-7', name: 'Fine BV', ...meta() },
    ]);

    expect(result).toMatchObject({ created: 1, skipped: 2, failed: 0 });
  });
});

describe('ingestRecords · people', () => {
  it('records employment in person_companies once the company is mapped', async () => {
    const connectionId = nextConnectionId();
    await ingest(connectionId, COMPANY_SYNC, [{ id: 'hs-c1', name: 'Employer BV', ...meta() }]);
    const result = await ingest(connectionId, PERSON_SYNC, [
      {
        id: 'hs-p1',
        first_name: 'Nadia',
        last_name: 'Bakker',
        email: `nadia-${Date.now()}@employer.example`,
        company_id: 'hs-c1',
        ...meta(),
      },
    ]);

    expect(result).toMatchObject({ created: 1 });

    const [personMapping] = await db
      .select()
      .from(schema.integrationEntityMappings)
      .where(
        and(
          eq(schema.integrationEntityMappings.connectionId, connectionId),
          eq(schema.integrationEntityMappings.externalEntityId, 'hs-p1'),
        ),
      );

    const links = await db
      .select()
      .from(schema.personCompanies)
      .where(eq(schema.personCompanies.personId, personMapping!.internalEntityId));
    expect(links).toHaveLength(1);
    expect(links[0]?.isPrimary).toBe(true);
  });

  it('does not open a second employment stint on re-sync', async () => {
    const connectionId = nextConnectionId();
    const email = `repeat-${Date.now()}@employer.example`;
    await ingest(connectionId, COMPANY_SYNC, [{ id: 'hs-c2', name: 'Repeat BV', ...meta() }]);

    await ingest(connectionId, PERSON_SYNC, [
      { id: 'hs-p2', first_name: 'Sam', last_name: 'Vos', email, company_id: 'hs-c2', ...meta() },
    ]);
    await ingest(connectionId, PERSON_SYNC, [
      {
        id: 'hs-p2',
        first_name: 'Sam',
        last_name: 'Vos',
        email,
        company_id: 'hs-c2',
        title: 'Ops Lead',
        ...meta({ last_action: 'UPDATED' }),
      },
    ]);

    const [personMapping] = await db
      .select()
      .from(schema.integrationEntityMappings)
      .where(
        and(
          eq(schema.integrationEntityMappings.connectionId, connectionId),
          eq(schema.integrationEntityMappings.externalEntityId, 'hs-p2'),
        ),
      );

    const links = await db
      .select()
      .from(schema.personCompanies)
      .where(eq(schema.personCompanies.personId, personMapping!.internalEntityId));
    expect(links).toHaveLength(1);
  });

  it('imports a person whose employer has not been synced yet', async () => {
    const connectionId = nextConnectionId();
    const result = await ingest(connectionId, PERSON_SYNC, [
      {
        id: 'hs-p3',
        first_name: 'Orphan',
        last_name: 'Contact',
        email: `orphan-${Date.now()}@nowhere.example`,
        company_id: 'not-synced-yet',
        ...meta(),
      },
    ]);

    // The person is worth having even without the employer link — the next run
    // resolves it once the company sync catches up.
    expect(result).toMatchObject({ created: 1, skipped: 0 });
  });
});

describe('ingestRecords · opportunities', () => {
  it('creates a deal once its account is mapped', async () => {
    const connectionId = nextConnectionId();
    await ingest(connectionId, COMPANY_SYNC, [{ id: 'hs-c3', name: 'Deal Co', ...meta() }]);

    const result = await ingest(connectionId, DEAL_SYNC, [
      {
        id: 'hs-d1',
        dealname: 'Retrofit programme',
        amount: '25000',
        dealstage: 'contractsent',
        closedate: '2026-12-01T00:00:00Z',
        company_id: 'hs-c3',
        ...meta(),
      },
    ]);

    expect(result).toMatchObject({ created: 1, failed: 0 });

    const [mapping] = await db
      .select()
      .from(schema.integrationEntityMappings)
      .where(
        and(
          eq(schema.integrationEntityMappings.connectionId, connectionId),
          eq(schema.integrationEntityMappings.externalEntityId, 'hs-d1'),
        ),
      );

    const [opportunity] = await db
      .select()
      .from(schema.crmOpportunities)
      .where(eq(schema.crmOpportunities.id, mapping!.internalEntityId));

    expect(opportunity).toMatchObject({
      name: 'Retrofit programme',
      stage: 'negotiation',
      status: 'open',
      ownerId: 'user_test',
    });
    expect(opportunity?.customerId).toBeTruthy();
  });

  it('skips a deal whose account is not mapped — customer_id is NOT NULL', async () => {
    const connectionId = nextConnectionId();
    const result = await ingest(connectionId, DEAL_SYNC, [
      { id: 'hs-d2', dealname: 'Orphan deal', company_id: 'unknown-account', ...meta() },
    ]);

    expect(result).toMatchObject({ created: 0, skipped: 1, failed: 0 });
  });
});
