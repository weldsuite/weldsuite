/**
 * Full create → get → update → delete round-trips against a real (pglite)
 * Postgres, for every entity whose create payload needs no FK parent we
 * can't fabricate. FK-dependent + inline-schema entities are auto-skipped
 * (covered by contract.test.ts instead).
 *
 * Bodies come from the entity's real create/update Zod schema via the
 * deterministic factory, so they match what the public API validates. If a
 * generated body trips a DB constraint, add a per-segment tweak to OVERRIDES.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import { CRUD_ENTITIES } from './entities';
import { buildCreateBody, buildUpdateBody, requiresParentFk } from './factory';
import type { Database } from '../db';
import { schema } from '../db';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** IDs seeded once for WeldBooks entity-scoped CRUD tests. */
let seededEntityId = '';
let seededContactId = '';
let seededBankAccountId = '';

async function seedAccountingFixtures(db: Database) {
  const now = new Date();
  seededEntityId = 'ent_testaccounting001';
  seededContactId = 'acn_testcontact00001';
  seededBankAccountId = 'ba_testbankaccount01';

  await db.insert(schema.entities).values({
    id: seededEntityId,
    name: 'Test Accounting Entity',
    jurisdictionCode: 'NL',
    baseCurrency: 'EUR',
    locale: 'nl-NL',
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.parties).values({
    id: seededContactId,
    displayName: 'Test Accounting Contact',
    role: 'customer',
    outstandingBalance: '0',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.bankAccounts).values({
    id: seededBankAccountId,
    entityId: seededEntityId,
    name: 'Test Bank',
    currency: 'EUR',
    createdAt: now,
    updatedAt: now,
  });
}

function resolveOverrides(seg: string): Record<string, unknown> {
  const raw = OVERRIDES[seg] ?? {};
  return JSON.parse(
    JSON.stringify(raw)
      .replaceAll('__SEEDED_ENTITY_ID__', seededEntityId)
      .replaceAll('__SEEDED_CONTACT_ID__', seededContactId)
      .replaceAll('__SEEDED_BANK_ACCOUNT_ID__', seededBankAccountId),
  ) as Record<string, unknown>;
}

/** Per-segment create-body overrides (merged over the generated body). */
const OVERRIDES: Record<string, Record<string, unknown>> = {
  // A conversation must identify a customer (route requires customerName).
  conversations: { customerName: 'Test Customer' },
  // WeldBooks entities share a seeded accounting entity id (see seedAccountingEntity).
  'gl-accounts': { entityId: '__SEEDED_ENTITY_ID__', code: '1000', name: 'Cash', type: 'asset', normalSide: 'debit' },
  'tax-rates': { entityId: '__SEEDED_ENTITY_ID__', jurisdiction: 'NL', rate: '21' },
  'bank-accounts': { entityId: '__SEEDED_ENTITY_ID__' },
  'bank-transactions': { entityId: '__SEEDED_ENTITY_ID__', bankAccountId: '__SEEDED_BANK_ACCOUNT_ID__' },
  'fiscal-periods': { entityId: '__SEEDED_ENTITY_ID__' },
  'fx-rates': { entityId: '__SEEDED_ENTITY_ID__' },
  'vat-returns': { entityId: '__SEEDED_ENTITY_ID__' },
  'reconciliation-rules': { entityId: '__SEEDED_ENTITY_ID__' },
  'recurring-invoices': { entityId: '__SEEDED_ENTITY_ID__', contactId: '__SEEDED_CONTACT_ID__' },
  'payments': { entityId: '__SEEDED_ENTITY_ID__' },
  'journal-entries': { entityId: '__SEEDED_ENTITY_ID__' },
  'accounting-documents': { entityId: '__SEEDED_ENTITY_ID__' },
  'icp-declarations': { entityId: '__SEEDED_ENTITY_ID__', periodStart: '2025-01-01', periodEnd: '2025-01-31' },
};

/**
 * Entities that can't be created from a self-contained body, so they get
 * contract coverage only (contract.test.ts) rather than a CRUD round-trip:
 * each needs a parent row whose FK column is NOT NULL in the DB while the
 * create schema marks it optional (the auto-classifier can't see the
 * DB-level constraint).
 */
const CONTRACT_ONLY: Record<string, string> = {
  invoices: 'needs contactId, issueDate, dueDate (NOT NULL FKs / columns)',
  bills: 'needs supplierId/contactId, issueDate, dueDate (NOT NULL FKs / columns)',
  'chat-messages': 'needs an existing channel (chat_messages.channel_id NOT NULL)',
  'chat-bookmarks': 'needs an existing message (FK chat_bookmarks.message_id)',
  goals: 'needs an existing project (project_goals.project_id NOT NULL)',
  milestones: 'needs an existing project (milestones.project_id NOT NULL)',
  sprints: 'needs an existing project (sprints.project_id NOT NULL)',
  whiteboards: 'needs an existing project (project_whiteboards.project_id NOT NULL)',
  // social_accounts.platform is a postgres enum; the external schema accepts any
  // string (permissive for extensibility), so the factory sends an invalid value.
  'social-accounts': 'platform is a postgres enum — factory value "test" rejected by DB constraint',
  // social_analytics.postId + accountId are NOT NULL FKs to parent rows.
  'social-analytics': 'needs existing social_posts + social_accounts parent rows (FK NOT NULL)',
};

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedAccountingFixtures(db);
}, 60_000);

describe('external-api · CRUD round-trip', () => {
  for (const entity of CRUD_ENTITIES) {
    const { seg, scope, create, update } = entity;
    const dependent = !create || requiresParentFk(create) || seg in CONTRACT_ONLY;
    const run = dependent ? it.skip : it;

    run(
      `${seg}: create → get → update → delete`,
      async () => {
        const scopes = [`${scope}:read`, `${scope}:write`];
        const { request } = createExternalTestApp({ scopes, tenantDb: db });

        // CREATE
        const createBody = { ...buildCreateBody(create!), ...resolveOverrides(seg) };
        const createRes = await request(`/v1/${seg}`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(createBody),
        });
        expect(createRes.status, `POST /v1/${seg} body=${JSON.stringify(createBody)} → ${await createRes.clone().text()}`).toBe(201);
        const created = (await createRes.json()) as { data: { id: string } };
        const id = created.data.id;
        expect(id).toBeTruthy();

        // GET
        const getRes = await request(`/v1/${seg}/${id}`);
        expect(getRes.status).toBe(200);
        const got = (await getRes.json()) as { data: { id: string } };
        expect(got.data.id).toBe(id);

        // UPDATE
        const updateBody = buildUpdateBody(update ?? create!);
        const patchRes = await request(`/v1/${seg}/${id}`, {
          method: 'PATCH',
          headers: JSON_HEADERS,
          body: JSON.stringify(updateBody),
        });
        expect(patchRes.status, `PATCH /v1/${seg}/${id} body=${JSON.stringify(updateBody)} → ${await patchRes.clone().text()}`).toBe(200);

        // DELETE
        const delRes = await request(`/v1/${seg}/${id}`, { method: 'DELETE' });
        expect(delRes.status).toBe(204);

        // GONE
        const goneRes = await request(`/v1/${seg}/${id}`);
        expect(goneRes.status).toBe(404);
      },
    );
  }
});
