/**
 * Form owner / publisher refs: the name and email come from the member row,
 * the picture from the person's account (master `users.image_url`, ADR
 * SEC-020), never the `workspace_members.picture` copy.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';

const holder = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => holder.master };
});

import { memberRef, memberRefs } from './members';

let db: Database;
const env = { DATABASE_URL_MASTER: 'postgres://test' } as Env;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
  const master: any = (await createMasterPgliteDb()).db;
  holder.master = master;
  const now = new Date('2026-01-01T10:00:00.000Z');
  await db.delete(schema.workspaceMembers);
  await db.insert(schema.workspaceMembers).values([
    // A stale per-workspace copy: never shown.
    { id: 'mbr_fm_ann', userId: 'user_fm_ann', email: 'ann@acme.test', name: 'Ann', picture: 'https://stale.test/ann.png', role: 'MEMBER', status: 'ACTIVE', createdAt: now, updatedAt: now },
    { id: 'mbr_fm_bo', userId: 'user_fm_bo', email: 'bo@acme.test', name: null, picture: 'https://stale.test/bo.png', role: 'MEMBER', status: 'ACTIVE', createdAt: now, updatedAt: now },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
  await master.delete(masterSchema.users);
  await master.insert(masterSchema.users).values([
    { id: 'user_fm_ann', email: 'ann@acme.test', imageUrl: 'https://img.clerk.test/ann.png' },
    { id: 'user_fm_bo', email: 'bo@acme.test', imageUrl: null },
  ]);
}, 60_000);

describe('memberRefs', () => {
  it('takes the picture from the account and ignores the member row copy', async () => {
    const refs = await memberRefs({ db, env }, ['user_fm_ann', 'user_fm_bo', 'user_fm_ann']);
    expect(refs.get('user_fm_ann')).toEqual({
      userId: 'user_fm_ann',
      name: 'Ann',
      email: 'ann@acme.test',
      imageUrl: 'https://img.clerk.test/ann.png',
    });
    // No account picture: null, not the member row's stale copy. The name falls back to the email.
    expect(refs.get('user_fm_bo')).toEqual({ userId: 'user_fm_bo', name: 'bo@acme.test', email: 'bo@acme.test', imageUrl: null });
  });

  it('gives a bare ref to someone without a member row', async () => {
    expect(await memberRef({ db, env }, 'user_fm_gone')).toEqual({ userId: 'user_fm_gone', name: null, email: null, imageUrl: null });
  });
});
