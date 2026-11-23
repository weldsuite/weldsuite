/**
 * /api/settings/profile against a real pglite tenant DB: the composed profile
 * (its picture is the ACCOUNT picture, master `users.image_url`), the merging
 * writes into `user_preferences.ui_preferences`, validation, the permission
 * gate, and the avatar upload's refusals. Runs in the Rust conformance suite
 * too (`rust/conformance/suites.json`). A successful upload sets the identity
 * provider's picture, which differs by edition (Clerk on Global), so it is
 * tested in settings-profile-avatar.test.ts, outside the suite.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { users } from '@weldsuite/db/schema/master';

const holder = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => conformanceMasterDb(holder.master) };
});

import { settingsProfileRoutes } from './index';

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

const ALICE = 'user_sp_alice';
const BOB = 'user_sp_bob';
const CAROL = 'user_sp_carol';

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  const now = new Date('2026-01-01T10:00:00.000Z');
  await db.insert(schema.workspaceMembers).values([
    // Alice's member row still carries a stale per-workspace picture: never shown.
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
  await master.delete(users);
  await master.insert(users).values([
    { id: ALICE, email: 'alice@acme.test', imageUrl: 'https://img.clerk.test/alice.png' },
    { id: BOB, email: 'bob@acme.test', imageUrl: 'https://img.clerk.test/bob-default.png' },
  ]);
}, 60_000);

function app(userId: string, keys: string[] = ['general:read']) {
  return createTestApp('/api/settings/profile', settingsProfileRoutes, {
    context: { tenantDb: db, masterDb: master, userId, permissions: permissions(...keys) },
    env: { CLERK_SECRET_KEY: 'sk_test_profile' } as never,
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
      // The account picture, not the member row's stale copy.
      picture: 'https://img.clerk.test/alice.png',
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
    expect(body.data.picture).toBe('');
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
  /** What the Clerk stub was sent: the multipart upload, as the TypeScript run sees it. */
  let uploads: Array<{ url: string; auth: string | null; file: File | null }>;
  let clerkStatus: number;

  beforeEach(() => {
    uploads = [];
    clerkStatus = 200;
    // Answers by URL and method: in conformance mode it answers the Rust run too.
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const match = /^https:\/\/api\.clerk\.com\/v1\/users\/([^/]+)\/profile_image$/.exec(url);
      if (init?.method === 'POST' && match) {
        const form = init.body instanceof FormData ? init.body : null;
        // workers-types types `get()` as string-only; at runtime the upload is a File.
        const file: unknown = form?.get('file');
        uploads.push({
          url,
          auth: new Headers(init.headers).get('Authorization'),
          file: file instanceof File ? file : null,
        });
        if (clerkStatus !== 200) return Response.json({ errors: [{ message: 'nope' }] }, { status: clerkStatus });
        const userId = decodeURIComponent(match[1]!);
        return Response.json({ id: userId, image_url: `https://img.clerk.test/${userId}-uploaded.png` });
      }
      return Response.json({}, { status: 404 });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['not a data URL', { file: 'https://example.test/me.png' }, 'Avatar must be a base64 data URL'],
    ['not base64', { file: 'data:image/png,rawbytes' }, 'Avatar must be a base64 data URL'],
    ['an unsupported type', { file: 'data:image/svg+xml;base64,PHN2Zy8+' }, 'Avatar must be a PNG, JPEG, GIF, WebP or AVIF image'],
    ['broken base64', { file: 'data:image/png;base64,a$b=' }, 'Avatar is not valid base64'],
    ['an empty image', { file: 'data:image/png;base64,' }, 'Avatar is empty'],
  ])('refuses %s', async (_name, body, message) => {
    const res = await app(BOB).request('/api/settings/profile/avatar', put(body));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toBe(message);
    expect(uploads).toHaveLength(0);
  });

  it('refuses an image over 5 MB', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    const res = await app(BOB).request('/api/settings/profile/avatar', put({ file: `data:image/png;base64,${big}` }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toBe('Avatar exceeds the 5MB limit');
  });

  it('refuses a body without a file', async () => {
    const res = await app(BOB).request('/api/settings/profile/avatar', put({ file: '' }));
    expect(res.status).toBe(400);
  });

  it('needs general:read', async () => {
    const res = await app(BOB, []).request(
      '/api/settings/profile/avatar',
      put({ file: 'data:image/png;base64,iVBORw0KGgo=' }),
    );
    expect(res.status).toBe(403);
  });
});
