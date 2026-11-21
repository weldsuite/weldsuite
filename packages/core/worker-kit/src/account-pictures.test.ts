/**
 * Avatars come from the account (`users.image_url` in the master database),
 * looked up in one batch, and a failed lookup degrades to "no picture".
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { users } from '@weldsuite/db/schema/master';
import { createMasterPgliteDb } from './testing/pglite';

const holder = vi.hoisted(() => ({ master: null as unknown, fail: false }));
vi.mock('./db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db')>();
  return {
    ...actual,
    getMasterDb: () => {
      if (holder.fail) throw new Error('master unreachable');
      return holder.master;
    },
  };
});

import { schema } from './db';
import { createPgliteDb } from './testing/pglite';
import {
  accountPicture,
  loadAccountPicture,
  loadAccountPictures,
  loadMemberProfile,
  tryLoadAccountPictures,
  tryLoadAccountPicturesFrom,
  withAccountPictures,
} from './account-pictures';

const env = { DATABASE_URL_MASTER: 'postgres://test' };

beforeAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
  const master: any = (await createMasterPgliteDb()).db;
  holder.master = master;
  await master.delete(users);
  await master.insert(users).values([
    { id: 'user_alice', email: 'alice@acme.test', imageUrl: 'https://img.clerk.test/alice.png' },
    { id: 'user_bob', email: 'bob@acme.test', imageUrl: null },
    { id: 'user_carol', email: 'carol@acme.test', imageUrl: '' },
  ]);
});

afterEach(() => {
  holder.fail = false;
});

describe('loadAccountPictures', () => {
  it('maps each known user to their account picture, null when the account has none', async () => {
    const pictures = await loadAccountPictures(env, ['user_alice', 'user_bob', 'user_carol', 'user_unknown']);
    expect(pictures.get('user_alice')).toBe('https://img.clerk.test/alice.png');
    expect(pictures.get('user_bob')).toBeNull();
    expect(pictures.get('user_carol')).toBeNull();
    expect(pictures.has('user_unknown')).toBe(false);
  });

  it('skips the query for no ids, and ignores empty and missing ids', async () => {
    holder.fail = true; // would throw if a lookup ran
    expect((await loadAccountPictures(env, [])).size).toBe(0);
    expect((await loadAccountPictures(env, [null, undefined, ''])).size).toBe(0);
  });

  it('tryLoadAccountPictures tells a failed lookup (null) from no picture', async () => {
    const found = await tryLoadAccountPictures(env, ['user_bob']);
    expect(found?.get('user_bob')).toBeNull();
    holder.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await tryLoadAccountPictures(env, ['user_alice'])).toBeNull();
    warn.mockRestore();
  });

  it('answers no pictures when the master database cannot be reached', async () => {
    holder.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await loadAccountPictures(env, ['user_alice'])).size).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('helpers', () => {
  it('loadAccountPicture resolves one user', async () => {
    expect(await loadAccountPicture(env, 'user_alice')).toBe('https://img.clerk.test/alice.png');
    expect(await loadAccountPicture(env, 'user_unknown')).toBeNull();
    expect(await loadAccountPicture(env, null)).toBeNull();
  });

  it('accountPicture reads a loaded map', async () => {
    const pictures = await loadAccountPictures(env, ['user_alice']);
    expect(accountPicture(pictures, 'user_alice')).toBe('https://img.clerk.test/alice.png');
    expect(accountPicture(pictures, 'user_bob')).toBeNull();
    expect(accountPicture(pictures, undefined)).toBeNull();
  });

  it('withAccountPictures replaces the stored picture, keeping every other field', async () => {
    const rows = await withAccountPictures(env, [
      { userId: 'user_alice', name: 'Alice', picture: 'https://stale.test/old.png' },
      { userId: 'user_unknown', name: 'Ghost', picture: 'https://stale.test/ghost.png' },
      { userId: null, name: 'Invite', picture: 'https://stale.test/invite.png' },
    ]);
    expect(rows).toEqual([
      { userId: 'user_alice', name: 'Alice', picture: 'https://img.clerk.test/alice.png' },
      { userId: 'user_unknown', name: 'Ghost', picture: null },
      { userId: null, name: 'Invite', picture: null },
    ]);
  });
});

describe('tryLoadAccountPicturesFrom', () => {
  it('reads the handle it is given, and treats a handle that cannot open as a failed lookup', async () => {
    const found = await tryLoadAccountPicturesFrom(() => holder.master as never, ['user_alice']);
    expect(found?.get('user_alice')).toBe('https://img.clerk.test/alice.png');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const open = vi.fn(() => {
      throw new Error('no connection string');
    });
    expect(await tryLoadAccountPicturesFrom(open, ['user_alice'])).toBeNull();
    warn.mockRestore();
    // Nothing to look up: the handle is never opened.
    open.mockClear();
    expect((await tryLoadAccountPicturesFrom(open, [null, ''])).size).toBe(0);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('loadMemberProfile', () => {
  it('takes the name from the member row (else its email) and the picture from the account', async () => {
    const { db } = await createPgliteDb();
    const now = new Date('2026-01-01T10:00:00.000Z');
    await db.delete(schema.workspaceMembers);
    await db.insert(schema.workspaceMembers).values([
      { id: 'mbr_ap_alice', userId: 'user_alice', email: 'alice@acme.test', name: 'Alice', picture: 'https://stale.test/a.png', role: 'MEMBER', status: 'ACTIVE', createdAt: now, updatedAt: now },
      { id: 'mbr_ap_bob', userId: 'user_bob', email: 'bob@acme.test', name: null, role: 'MEMBER', status: 'ACTIVE', createdAt: now, updatedAt: now },
      { id: 'mbr_ap_gone', userId: 'user_carol', email: 'carol@acme.test', name: 'Carol', role: 'MEMBER', status: 'ACTIVE', createdAt: now, updatedAt: now, deletedAt: now },
    ] as (typeof schema.workspaceMembers.$inferInsert)[]);

    expect(await loadMemberProfile(env, db, 'user_alice')).toEqual({ name: 'Alice', picture: 'https://img.clerk.test/alice.png' });
    expect(await loadMemberProfile(env, db, 'user_bob')).toEqual({ name: 'bob@acme.test', picture: null });
    // A removed member has no name; the picture is still the account's (none here).
    expect(await loadMemberProfile(env, db, 'user_carol')).toEqual({ name: null, picture: null });
  });
});
