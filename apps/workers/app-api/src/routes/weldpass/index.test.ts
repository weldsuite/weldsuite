/**
 * DB-backed tests for /api/weldpass.
 *
 * Two things must never regress here, so they get direct coverage:
 *
 *   1. `secrets:read` must NOT be enough to see a value. Listing and revealing
 *      are separate grants on purpose, and a refactor that collapses them would
 *      silently hand every reader the production credentials.
 *   2. A project id from another workspace must read as 404, not 403 — the
 *      tenant DB is shared by nothing, but `workspace_id` is still the filter
 *      that stops one org addressing another's vault by id.
 *
 * The envelope crypto itself is unit-tested in
 * `services/weldpass/envelope.test.ts`; here it runs for real against pglite so
 * the seal → store → read → open round trip is exercised through the routes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { weldpassRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

const ROOT_KEY = 'a'.repeat(64);
const BASE = '/api/weldpass';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

/** An app whose caller holds exactly `grants`, in workspace `workspaceId`. */
function app(grants: string[], workspaceId = 'org_test_default') {
  return createTestApp(BASE, weldpassRoutes, {
    context: {
      permissions: permissions(...grants),
      tenantDb: db,
      workspaceId,
      orgId: workspaceId,
    },
    env: { WELDPASS_ROOT_KEY: ROOT_KEY },
  });
}

async function createProject(name: string, workspaceId = 'org_test_default') {
  const { request } = app(['secrets:manage'], workspaceId);
  const res = await request(`${BASE}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    data: { id: string; slug: string; environments: Array<{ id: string; slug: string }> };
  };
  return body.data;
}

async function addSecret(
  projectId: string,
  environmentId: string,
  key: string,
  value: string,
) {
  const { request } = app(['secrets:manage']);
  const res = await request(
    `${BASE}/projects/${projectId}/environments/${environmentId}/secrets`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    },
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { secret: { id: string } } };
  return body.data.secret;
}

describe('/api/weldpass · permission gates', () => {
  it('refuses to list projects without secrets:read', async () => {
    const { request } = app(['companies:read']);
    expect((await request(`${BASE}/projects`)).status).toBe(403);
  });

  it('refuses to create a project without create or manage', async () => {
    const { request } = app(['secrets:read']);
    const res = await request(`${BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Nope' }),
    });
    expect(res.status).toBe(403);
  });

  it('does NOT let secrets:read reveal a value', async () => {
    const project = await createProject('Reveal gate');
    const environment = project.environments[0];
    const secret = await addSecret(project.id, environment.id, 'API_KEY', 'sk_live_gate');

    const { request } = app(['secrets:read']);
    const res = await request(
      `${BASE}/projects/${project.id}/environments/${environment.id}/secrets/${secret.id}/reveal`,
    );
    expect(res.status).toBe(403);
  });

  it('does NOT let secrets:read export an environment', async () => {
    const project = await createProject('Export gate');
    const environment = project.environments[0];

    const { request } = app(['secrets:read']);
    const res = await request(
      `${BASE}/projects/${project.id}/environments/${environment.id}/secrets/export`,
    );
    expect(res.status).toBe(403);
  });

  it('gates the audit trail behind manage, not read', async () => {
    const project = await createProject('Audit gate');

    expect((await app(['secrets:read']).request(`${BASE}/projects/${project.id}/audit`)).status).toBe(
      403,
    );
    expect(
      (await app(['secrets:manage']).request(`${BASE}/projects/${project.id}/audit`)).status,
    ).toBe(200);
  });

  it('gates a push behind sync, not read', async () => {
    const project = await createProject('Sync gate');
    const { request } = app(['secrets:read']);
    const res = await request(`${BASE}/projects/${project.id}/sync-targets/wpt_missing/push`, {
      method: 'POST',
    });
    expect(res.status).toBe(403);
  });
});

describe('/api/weldpass · workspace isolation', () => {
  it('hides another workspace’s project behind a 404', async () => {
    const mine = await createProject('Isolation', 'org_owner');

    // The intruder is a legitimate reader *in their own workspace* — the point
    // is that the id resolves to nothing for them, not that they lack the grant.
    const { request } = app(['secrets:read'], 'org_intruder');
    const res = await request(`${BASE}/projects/${mine.id}`);
    expect(res.status).toBe(404);
  });

  it('will not list another workspace’s projects', async () => {
    await createProject('Only mine', 'org_alpha');

    const { request } = app(['secrets:read'], 'org_beta');
    const res = await request(`${BASE}/projects`);
    const body = (await res.json()) as { data: Array<{ name: string }> };
    expect(body.data.some((p) => p.name === 'Only mine')).toBe(false);
  });
});

describe('/api/weldpass · secrets', () => {
  it('creates a project with the three default environments', async () => {
    const project = await createProject('Defaults');
    expect(project.environments.map((e) => e.slug).sort()).toEqual([
      'development',
      'preview',
      'production',
    ]);
  });

  it('never returns a plaintext value from the list endpoint', async () => {
    const project = await createProject('Masked list');
    const environment = project.environments[0];
    await addSecret(project.id, environment.id, 'DATABASE_URL', 'postgres://u:p@h/db');

    const { request } = app(['secrets:read']);
    const res = await request(
      `${BASE}/projects/${project.id}/environments/${environment.id}/secrets`,
    );
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).not.toContain('postgres://u:p@h/db');
    expect(text).toContain('DATABASE_URL');
  });

  it('stores nothing readable in the database', async () => {
    const project = await createProject('At rest');
    const environment = project.environments[0];
    await addSecret(project.id, environment.id, 'TOKEN', 'super-secret-at-rest');

    const [row] = await db
      .select()
      .from(schema.weldpassSecrets)
      .where(
        and(
          eq(schema.weldpassSecrets.environmentId, environment.id),
          eq(schema.weldpassSecrets.key, 'TOKEN'),
        ),
      );

    expect(JSON.stringify(row)).not.toContain('super-secret-at-rest');
    expect(row.ciphertext.length).toBeGreaterThan(0);
    expect(row.valueHint).toBe('rest');
  });

  it('round-trips a value through reveal for a caller with secrets:reveal', async () => {
    const project = await createProject('Round trip');
    const environment = project.environments[0];
    const secret = await addSecret(project.id, environment.id, 'API_KEY', 'sk_live_roundtrip');

    const { request } = app(['secrets:reveal']);
    const res = await request(
      `${BASE}/projects/${project.id}/environments/${environment.id}/secrets/${secret.id}/reveal`,
    );
    const body = (await res.json()) as { data: { value: string } };

    expect(res.status).toBe(200);
    expect(body.data.value).toBe('sk_live_roundtrip');
  });

  it('records the reveal in the audit trail', async () => {
    const project = await createProject('Audited reveal');
    const environment = project.environments[0];
    const secret = await addSecret(project.id, environment.id, 'AUDITED', 'value-to-read');

    await app(['secrets:reveal']).request(
      `${BASE}/projects/${project.id}/environments/${environment.id}/secrets/${secret.id}/reveal`,
    );

    const events = await db
      .select()
      .from(schema.weldpassAuditEvents)
      .where(eq(schema.weldpassAuditEvents.projectId, project.id));

    const reveal = events.find((e) => e.action === 'secret.revealed');
    expect(reveal).toBeDefined();
    expect(reveal?.targetKey).toBe('AUDITED');
    // The trail records the key, never the value.
    expect(JSON.stringify(events)).not.toContain('value-to-read');
  });

  it('rejects a key no deploy target would accept', async () => {
    const project = await createProject('Bad key');
    const environment = project.environments[0];

    const { request } = app(['secrets:manage']);
    const res = await request(
      `${BASE}/projects/${project.id}/environments/${environment.id}/secrets`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'has-dash', value: 'x' }),
      },
    );
    expect(res.status).toBe(400);
  });

  it('treats an unchanged re-import as a no-op rather than a new version', async () => {
    const project = await createProject('Idempotent import');
    const environment = project.environments[0];
    const dotenv = 'FIRST=one\nSECOND=two\n';

    const { request } = app(['secrets:manage']);
    const importUrl = `${BASE}/projects/${project.id}/environments/${environment.id}/secrets/import`;
    const post = (body: unknown) =>
      request(importUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const first = (await (await post({ content: dotenv })).json()) as {
      data: { created: string[] };
    };
    expect(first.data.created.sort()).toEqual(['FIRST', 'SECOND']);

    const second = (await (await post({ content: dotenv })).json()) as {
      data: { created: string[]; updated: string[]; unchanged: string[] };
    };
    expect(second.data.created).toEqual([]);
    expect(second.data.updated).toEqual([]);
    expect(second.data.unchanged.sort()).toEqual(['FIRST', 'SECOND']);
  });

  it('keeps history and restores an earlier value', async () => {
    const project = await createProject('History');
    const environment = project.environments[0];
    const secret = await addSecret(project.id, environment.id, 'ROTATING', 'v1-value');

    const secretUrl = `${BASE}/projects/${project.id}/environments/${environment.id}/secrets/${secret.id}`;
    // This flow crosses grants — editing is `update`/`manage`, but listing the
    // history is `read`. An ADMIN holds all of them; the narrow single-grant
    // apps above are for proving the gates, not for driving a whole flow.
    const manage = app(['secrets:read', 'secrets:update', 'secrets:manage']);

    await manage.request(secretUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'v2-value' }),
    });

    const versions = (await (await manage.request(`${secretUrl}/versions`)).json()) as {
      data: Array<{ version: number; action: string }>;
    };
    expect(versions.data.length).toBeGreaterThanOrEqual(2);

    await manage.request(`${secretUrl}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1 }),
    });

    const revealed = (await (
      await app(['secrets:reveal']).request(`${secretUrl}/reveal`)
    ).json()) as { data: { value: string } };
    expect(revealed.data.value).toBe('v1-value');
  });
});

describe('/api/weldpass · provider credentials', () => {
  it('never returns a stored token', async () => {
    const project = await createProject('Token safety');

    const { request } = app(['secrets:manage']);
    const created = await request(`${BASE}/projects/${project.id}/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'cloudflare_workers',
        name: 'CF prod',
        token: 'cf-token-should-never-return',
        metadata: { accountId: 'acct_1' },
      }),
    });
    expect(created.status).toBe(201);
    expect(await created.text()).not.toContain('cf-token-should-never-return');

    const listed = await request(`${BASE}/projects/${project.id}/credentials`);
    expect(await listed.text()).not.toContain('cf-token-should-never-return');
  });

  it('refuses a target whose credential is for another provider', async () => {
    const project = await createProject('Provider mismatch');
    const environment = project.environments[0];
    const { request } = app(['secrets:manage']);

    const credential = (await (
      await request(`${BASE}/projects/${project.id}/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'vercel',
          name: 'Vercel',
          token: 'vercel-token',
        }),
      })
    ).json()) as { data: { id: string } };

    const res = await request(`${BASE}/projects/${project.id}/sync-targets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        environmentId: environment.id,
        credentialId: credential.data.id,
        name: 'Mismatched',
        config: {
          provider: 'cloudflare_workers',
          accountId: 'acct_1',
          scriptName: 'some-worker',
        },
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('/api/weldpass · configuration', () => {
  it('answers with a clear error when the root key is missing', async () => {
    const { request } = createTestApp(BASE, weldpassRoutes, {
      context: { permissions: permissions('secrets:manage'), tenantDb: db },
      env: { WELDPASS_ROOT_KEY: undefined },
    });

    const res = await request(`${BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No key' }),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CRYPTO_ERROR');
  });
});
