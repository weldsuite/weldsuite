/**
 * PUT /api/settings/profile/avatar on Global: the upload becomes the person's
 * Clerk profile image, and the URL Clerk returns is recorded on the account
 * (master `users.image_url`), never on the workspace member row (ADR SEC-020).
 *
 * Not in the Rust conformance suite: setting the picture is identity-provider
 * work and differs by edition. Rust (Kubernetes) has no Clerk; it stores the
 * image in the public bucket and records that URL on the account
 * (`rust/modules/core-team/src/groups/settings_profile.rs`). The route's
 * validation and permission answers are the same on both and stay in
 * settings-profile.integration.test.ts, which conformance runs.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { users } from '@weldsuite/db/schema/master';

const holder = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => holder.master };
});

import { settingsProfileRoutes } from './index';

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

const ALICE = 'user_spa_alice';
const BOB = 'user_spa_bob';

/** What the Clerk stub was sent. */
let uploads: Array<{ url: string; auth: string | null; file: File | null }>;
let clerkStatus: number;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  const now = new Date('2026-01-01T10:00:00.000Z');
  await db.insert(schema.workspaceMembers).values([
    { id: 'mbr_spa_alice', userId: ALICE, email: 'alice@acme.test', name: 'Alice', role: 'MEMBER', status: 'ACTIVE', createdAt: now, updatedAt: now },
    { id: 'mbr_spa_bob', userId: BOB, email: 'bob@acme.test', name: 'Bob', role: 'MEMBER', status: 'ACTIVE', createdAt: now, updatedAt: now },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
  await master.delete(users);
  await master.insert(users).values([
    { id: ALICE, email: 'alice@acme.test', imageUrl: 'https://img.clerk.test/alice.png' },
    { id: BOB, email: 'bob@acme.test', imageUrl: 'https://img.clerk.test/bob-default.png' },
  ]);
}, 60_000);

beforeEach(() => {
  uploads = [];
  clerkStatus = 200;
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

function app(userId: string) {
  return createTestApp('/api/settings/profile', settingsProfileRoutes, {
    context: { tenantDb: db, masterDb: master, userId, permissions: permissions('general:read') },
    env: { CLERK_SECRET_KEY: 'sk_test_profile' } as never,
  });
}

function put(body: unknown): RequestInit {
  return { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function accountPictureOf(userId: string): Promise<string | null> {
  const [row] = await master.select({ imageUrl: users.imageUrl }).from(users).where(eq(users.id, userId));
  return row?.imageUrl ?? null;
}

describe('PUT /api/settings/profile/avatar (Clerk)', () => {
  it('sets the Clerk profile image and records it on the account, not the member row', async () => {
    const res = await app(BOB).request(
      '/api/settings/profile/avatar',
      put({ file: 'data:image/png;base64,iVBORw0KGgo=', fileName: 'me.png' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { imageUrl: string } };
    expect(body.data.imageUrl).toBe('https://img.clerk.test/user_spa_bob-uploaded.png');

    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.url).toBe('https://api.clerk.com/v1/users/user_spa_bob/profile_image');
    expect(uploads[0]!.auth).toBe('Bearer sk_test_profile');
    expect(uploads[0]!.file?.type).toBe('image/png');
    expect(uploads[0]!.file?.size).toBe(8);

    expect(await accountPictureOf(BOB)).toBe(body.data.imageUrl);
    const [member] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, BOB));
    expect(member?.picture).toBeNull();

    // The profile now shows the new account picture.
    const profile = await app(BOB).request('/api/settings/profile');
    expect(((await profile.json()) as { data: { picture: string } }).data.picture).toBe(body.data.imageUrl);
  });

  it('takes the media type from contentType when the data URL has none', async () => {
    const res = await app(BOB).request(
      '/api/settings/profile/avatar',
      put({ file: 'data:;base64,iVBORw0KGgo=', contentType: 'IMAGE/JPEG' }),
    );
    expect(res.status).toBe(200);
    expect(uploads[0]!.file?.type).toBe('image/jpeg');
    expect(uploads[0]!.file?.name).toMatch(/\.jpg$/);
  });

  it('answers 500 and leaves the account alone when Clerk refuses the image', async () => {
    clerkStatus = 422;
    const before = await accountPictureOf(ALICE);
    const res = await app(ALICE).request(
      '/api/settings/profile/avatar',
      put({ file: 'data:image/png;base64,iVBORw0KGgo=' }),
    );
    expect(res.status).toBe(500);
    expect(await accountPictureOf(ALICE)).toBe(before);
  });
});
