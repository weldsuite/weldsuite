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

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Per-segment create-body overrides (merged over the generated body). */
const OVERRIDES: Record<string, Record<string, unknown>> = {
  // A conversation must identify a customer (route requires customerName).
  conversations: { customerName: 'Test Customer' },
};

/**
 * Entities that can't be created from a self-contained body, so they get
 * contract coverage only (contract.test.ts) rather than a CRUD round-trip:
 * each needs a parent row whose FK column is NOT NULL in the DB while the
 * create schema marks it optional (the auto-classifier can't see the
 * DB-level constraint).
 */
const CONTRACT_ONLY: Record<string, string> = {
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
        const createBody = { ...buildCreateBody(create!), ...(OVERRIDES[seg] ?? {}) };
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
