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

import { accountPicture, loadAccountPicture, loadAccountPictures, withAccountPictures } from './account-pictures';

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
