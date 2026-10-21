/**
 * /v1/files keys and downloads (TASK-620).
 *
 *   - a file's storagePath / fileKey must be under the workspace's own
 *     `workspaces/<id>/` prefix (Clerk org id or master workspace id);
 *   - `GET /v1/files/:id/content` downloads the stored object, private bucket
 *     included, under the WeldDrive sharing rules and the `files:read` scope;
 *   - a row that names another workspace's key (written before the check)
 *     downloads nothing.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import { schema, type Database } from '../db';
import type { ApiKeySession, Env } from '../types';

const ORG_ID = 'org_files_test';
const WS_ID = 'ws_files_test';
const OWN = `workspaces/${ORG_ID}/drive/general/1_abc/report.pdf`;
const INBOX = `workspaces/${WS_ID}/accounting/inbox/e1/scan.png`;
const FOREIGN = 'workspaces/org_victim/drive/general/1_abc/payroll.pdf';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

let db: Database;

function session(fields: Partial<ApiKeySession> = {}): ApiKeySession {
  return {
    keyId: 'key_files_test',
    keyType: 'personal',
    workspaceId: WS_ID,
    userId: 'user_files_owner',
    scopes: ['*'],
    tier: 'enterprise',
    databaseUrl: null,
    clerkOrgId: ORG_ID,
    licensedApps: null,
    ...fields,
  };
}

/** Only the private bucket holds objects, as for a private upload. */
function storageEnv(): Partial<Env> {
  const objects = new Map<string, string>([
    [OWN, '%PDF-own'],
    [INBOX, 'png-bytes'],
    [FOREIGN, '%PDF-theirs'],
  ]);
  const view = (key: string) => ({
    key,
    size: objects.get(key)!.length,
    httpMetadata: { contentType: 'application/octet-stream' },
    body: new Blob([objects.get(key)!]).stream(),
  });
  const bucket = {
    get: async (key: string) => (objects.has(key) ? view(key) : null),
    head: async (key: string) => (objects.has(key) ? view(key) : null),
  };
  return { PRIVATE_STORAGE: bucket as unknown as R2Bucket };
}

const request = (sess: ApiKeySession = session(), env: Partial<Env> = storageEnv()) =>
  createExternalTestApp({ session: sess, tenantDb: db, env }).request;

async function seedFile(id: string, key: string, fields: Partial<typeof schema.files.$inferInsert> = {}) {
  await db.insert(schema.files).values({
    id,
    fileName: key.split('/').pop()!,
    mimeType: 'application/pdf',
    fileSize: 8,
    storagePath: key,
    fileKey: key,
    uploadedById: 'user_files_owner',
    ...fields,
  } as typeof schema.files.$inferInsert);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedFile('fil_x_own', OWN);
  await seedFile('fil_x_inbox', INBOX, { mimeType: 'image/png' });
  await seedFile('fil_x_foreign', FOREIGN);
  await seedFile('fil_x_restricted', OWN, { generalAccess: 'restricted' });
}, 180_000);

describe('POST /v1/files', () => {
  const create = (body: Record<string, unknown>) =>
    request()('/v1/files', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ fileName: 'r.pdf', mimeType: 'application/pdf', fileSize: 8, ...body }),
    });

  it('stores a key of this workspace and records the bucket it is in', async () => {
    const res = await create({ storagePath: OWN, bucket: 'public' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const [row] = await db.select().from(schema.files).where(eq(schema.files.id, data.id));
    expect(row?.bucket).toBe('private');
    expect((await create({ storagePath: INBOX })).status).toBe(201);
  });

  it("refuses another workspace's key, a traversal and an unscoped key", async () => {
    expect((await create({ storagePath: FOREIGN })).status).toBe(400);
    expect((await create({ storagePath: OWN, fileKey: FOREIGN })).status).toBe(400);
    expect((await create({ storagePath: `workspaces/${ORG_ID}/../org_victim/x.pdf` })).status).toBe(400);
    expect((await create({ storagePath: 'avatars/x.png' })).status).toBe(400);
  });
});

describe('GET /v1/files/:id/content', () => {
  it('downloads a private file as an attachment', async () => {
    const res = await request()('/v1/files/fil_x_own/content');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-own');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="report\.pdf"/);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('downloads a file keyed by the master workspace id', async () => {
    const res = await request()('/v1/files/fil_x_inbox/content');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('png-bytes');
  });

  it("never serves another workspace's object", async () => {
    expect((await request()('/v1/files/fil_x_foreign/content')).status).toBe(404);
  });

  it('follows the sharing rules', async () => {
    // A workspace key (no user) sees what is not restricted.
    const workspaceKey = session({ keyType: 'workspace', userId: null });
    expect((await request(workspaceKey)('/v1/files/fil_x_own/content')).status).toBe(200);
    expect((await request(workspaceKey)('/v1/files/fil_x_restricted/content')).status).toBe(404);
    // Its owner opens the restricted one.
    expect((await request()('/v1/files/fil_x_restricted/content')).status).toBe(200);
  });

  it('needs files:read', async () => {
    const res = await request(session({ scopes: ['folders:read'] }))('/v1/files/fil_x_own/content');
    expect(res.status).toBe(403);
  });

  it('is 404 for a missing object and 503 without storage', async () => {
    await seedFile('fil_x_gone', `workspaces/${ORG_ID}/drive/general/1_abc/gone.pdf`);
    expect((await request()('/v1/files/fil_x_gone/content')).status).toBe(404);
    expect((await request(session(), {})('/v1/files/fil_x_own/content')).status).toBe(503);
  });
});
