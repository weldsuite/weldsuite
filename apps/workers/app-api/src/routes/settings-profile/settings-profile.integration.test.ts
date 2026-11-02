/**
 * /api/settings/profile against a real pglite tenant DB: the composed profile,
 * the merging writes into `user_preferences.ui_preferences`, validation, the
 * permission gate, and the avatar upload to the public bucket. Runs in the
 * Rust conformance suite too (`rust/conformance/suites.json`).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { settingsProfileRoutes } from './index';

let db: Database;

/** In-memory stand-in for an R2 bucket. */
function memoryBucket() {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const bucket = {
    async put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes: new Uint8Array(value), contentType: options?.httpMetadata?.contentType });
      return {};
    },
    async get(key: string) {
      const object = objects.get(key);
      return object ? { body: new Blob([object.bytes]).stream(), httpMetadata: { contentType: object.contentType } } : null;
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}

const publicBucket = memoryBucket();
const privateBucket = memoryBucket();

const ALICE = 'user_sp_alice';
const BOB = 'user_sp_bob';
const CAROL = 'user_sp_carol';

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date('2026-01-01T10:00:00.000Z');
  await db.insert(schema.workspaceMembers).values([
    { id: 'mbr_sp_alice', userId: ALICE, email: 'alice@acme.test', name: 'Alice', picture: 'https://cdn.test/a.png', role: 'MEMBER', status: 'ACTIVE', createdAt: now, updatedAt: now },
    { id: 'mbr_sp_bob', userId: BOB, email: 'bob@acme.test', name: 'Bob', role: 'MEMBER', status: 'ACTIVE', createdAt: now, updatedAt: now },
    { id: 'mbr_sp_carol', userId: CAROL, email: 'carol@acme.test', name: 'Carol', role: 'VIEWER', status: 'ACTIVE', createdAt: now, updatedAt: now },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
  await db.insert(schema.userPreferences).values({
    id: 'upref_sp_alice',
    userId: ALICE,
    timezone: 'Europe/Amsterdam',
    uiPreferences: { sidebarCollapsed: true, profile: { nickname: 'Al', company: 'Acme' } } as never,
    createdAt: now,
    updatedAt: now,
  });
}, 60_000);

function app(userId: string, keys: string[] = ['general:read']) {
  return createTestApp('/api/settings/profile', settingsProfileRoutes, {
    context: { tenantDb: db, userId, permissions: permissions(...keys) },
    env: { STORAGE: publicBucket.bucket, PRIVATE_STORAGE: privateBucket.bucket, R2_PUBLIC_URL: 'https://files.acme.test' } as never,
  });
}

function put(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

async function prefsOf(userId: string) {
  const [row] = await db.select().from(schema.userPreferences).where(eq(schema.userPreferences.userId, userId));
  return row;
}

describe('GET /api/settings/profile', () => {
  it('composes the member row with the profile bag and the timezone', async () => {
    const res = await app(ALICE).request('/api/settings/profile');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, string> };
    expect(body.data).toEqual({
      id: 'mbr_sp_alice',
      email: 'alice@acme.test',
      name: 'Alice',
      nickname: 'Al',
      picture: 'https://cdn.test/a.png',
      phone: '',
      company: 'Acme',
      jobTitle: '',
      bio: '',
      timezone: 'Europe/Amsterdam',
    });
  });

  it('falls back to the user id and defaults without any rows', async () => {
    const res = await app('user_sp_nobody').request('/api/settings/profile');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, string> };
    expect(body.data.id).toBe('user_sp_nobody');
    expect(body.data.timezone).toBe('UTC');
    expect(body.data.email).toBe('');
  });

  it('needs general:read', async () => {
    const res = await app(ALICE, []).request('/api/settings/profile');
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/settings/profile', () => {
  it('writes the name and merges the profile bag, keeping sibling keys', async () => {
    const res = await app(ALICE).request(
      '/api/settings/profile',
      put({ name: '  Alice Smith ', phone: '  +31   20 123 4567 ', jobTitle: 'CTO' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, string> };
    expect(body.data.name).toBe('Alice Smith');
    expect(body.data.phone).toBe('+31 20 123 4567');
    expect(body.data.jobTitle).toBe('CTO');
    expect(body.data.nickname).toBe('Al');
    const prefs = await prefsOf(ALICE);
    expect(prefs?.uiPreferences).toMatchObject({
      sidebarCollapsed: true,
      profile: { nickname: 'Al', company: 'Acme', jobTitle: 'CTO', phone: '+31 20 123 4567' },
    });
    expect(prefs?.timezone).toBe('Europe/Amsterdam');
  });

  it('a timezone-only save leaves ui_preferences alone', async () => {
    const res = await app(ALICE).request('/api/settings/profile', put({ timezone: 'Asia/Tokyo' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, string> };
    expect(body.data.timezone).toBe('Asia/Tokyo');
    expect((await prefsOf(ALICE))?.uiPreferences).toMatchObject({ sidebarCollapsed: true });
  });

  it('creates the preferences row when the user has none', async () => {
    const res = await app(BOB).request('/api/settings/profile', put({ bio: 'Hello', nickname: 'B' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, string> };
    expect(body.data).toMatchObject({ bio: 'Hello', nickname: 'B', timezone: 'UTC', name: 'Bob' });
    expect((await prefsOf(BOB))?.uiPreferences).toEqual({ profile: { bio: 'Hello', nickname: 'B' } });
  });

  it('creates a row with only the timezone', async () => {
    const res = await app(CAROL).request('/api/settings/profile', put({ timezone: 'Europe/Paris' }));
    expect(res.status).toBe(200);
    const prefs = await prefsOf(CAROL);
    expect(prefs?.timezone).toBe('Europe/Paris');
    expect(prefs?.uiPreferences).toBeNull();
  });

  it('refuses a blank name, a bad phone and an empty timezone', async () => {
    const res = await app(ALICE).request(
      '/api/settings/profile',
      put({ name: '   ', phone: 'call me', timezone: '' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { issues: Array<{ path: string[]; message: string }> } };
    expect(body.error.issues.map((i) => [i.path[0], i.message])).toEqual([
      ['name', 'Name is required'],
      ['timezone', 'String must contain at least 1 character(s)'],
      // zValidator parses asynchronously: refinements report last.
      ['phone', 'Enter a valid phone number'],
    ]);
  });

  it('refuses a name that is too long and fields of the wrong type', async () => {
    const res = await app(ALICE).request('/api/settings/profile', put({ name: 'x'.repeat(201), bio: 3 }));
    expect(res.status).toBe(400);
  });

  it('needs general:read', async () => {
    const res = await app(ALICE, []).request('/api/settings/profile', put({ bio: 'x' }));
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/settings/profile/avatar', () => {
  // Hono builds the URL as http://localhost; the Rust server, behind an
  // ingress, reads the original host from X-Forwarded-Host.
  const local = { 'X-Forwarded-Host': 'localhost' };

  it('stores the image in the public bucket and saves its URL', async () => {
    const res = await app(BOB).request(
      '/api/settings/profile/avatar',
      put({ file: 'data:image/png;base64,iVBORw0KGgo=', fileName: 'me.png' }, local),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { imageUrl: string } };
    expect(body.data.imageUrl).toMatch(
      /^http:\/\/localhost\/api\/storage\/public\/workspaces\/org_test_default\/avatars\/user_sp_bob_\d+\.png$/,
    );
    const key = body.data.imageUrl.replace('http://localhost/api/storage/public/', '');
    expect(publicBucket.objects.get(key)?.bytes.byteLength).toBe(8);
    const [member] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, BOB));
    expect(member?.picture).toBe(body.data.imageUrl);
  });

  it('takes the media type from contentType when the data URL has none', async () => {
    const res = await app(BOB).request(
      '/api/settings/profile/avatar',
      put({ file: 'data:;base64,iVBORw0KGgo=', contentType: 'IMAGE/JPEG' }, local),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { imageUrl: string } };
    expect(body.data.imageUrl).toMatch(/\.jpg$/);
  });

  it.each([
    ['not a data URL', { file: 'https://example.test/me.png' }, 'Avatar must be a base64 data URL'],
    ['not base64', { file: 'data:image/png,rawbytes' }, 'Avatar must be a base64 data URL'],
    ['an unsupported type', { file: 'data:image/svg+xml;base64,PHN2Zy8+' }, 'Avatar must be a PNG, JPEG, GIF, WebP or AVIF image'],
    ['broken base64', { file: 'data:image/png;base64,a$b=' }, 'Avatar is not valid base64'],
    ['an empty image', { file: 'data:image/png;base64,' }, 'Avatar is empty'],
  ])('refuses %s', async (_name, body, message) => {
    const res = await app(BOB).request('/api/settings/profile/avatar', put(body, local));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toBe(message);
  });

  it('refuses an image over 5 MB', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    const res = await app(BOB).request('/api/settings/profile/avatar', put({ file: `data:image/png;base64,${big}` }, local));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toBe('Avatar exceeds the 5MB limit');
  });

  it('refuses a body without a file', async () => {
    const res = await app(BOB).request('/api/settings/profile/avatar', put({ file: '' }, local));
    expect(res.status).toBe(400);
  });

  it('needs general:read', async () => {
    const res = await app(BOB, []).request(
      '/api/settings/profile/avatar',
      put({ file: 'data:image/png;base64,iVBORw0KGgo=' }, local),
    );
    expect(res.status).toBe(403);
  });
});
