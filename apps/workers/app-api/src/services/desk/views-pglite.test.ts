/**
 * pglite-backed service tests for services/desk/views.ts — owner-only
 * mutation semantics and owned-vs-shared list visibility.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  createDeskView,
  deleteDeskView,
  DeskViewForbiddenError,
  DeskViewNotFoundError,
  listDeskViews,
  updateDeskView,
} from './views';
import { createPgliteDb } from '../../test/pglite';
import type { Database } from '../../db';

let db: Database;

const emptyFilters = { groups: [] };

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('desk views · pglite integration', () => {
  it('list returns own private views but not other users\' private views', async () => {
    const mine = await createDeskView(db, 'user_owner_a', {
      name: 'My private view',
      filters: emptyFilters,
      sort: 'newest',
      shared: false,
    });
    await createDeskView(db, 'user_owner_b', {
      name: 'Their private view',
      filters: emptyFilters,
      sort: 'newest',
      shared: false,
    });

    const list = await listDeskViews(db, 'user_owner_a');
    expect(list.some((v) => v.id === mine.id)).toBe(true);
    expect(list.every((v) => v.ownerId === 'user_owner_a')).toBe(true);
  });

  it('list includes shared views owned by other users', async () => {
    const shared = await createDeskView(db, 'user_owner_c', {
      name: 'Shared view',
      filters: emptyFilters,
      sort: 'newest',
      shared: true,
    });

    const list = await listDeskViews(db, 'user_someone_else');
    expect(list.some((v) => v.id === shared.id)).toBe(true);
  });

  it('update by the owner succeeds', async () => {
    const view = await createDeskView(db, 'user_owner_d', {
      name: 'Owned',
      filters: emptyFilters,
      sort: 'newest',
      shared: false,
    });
    const updated = await updateDeskView(db, view.id, 'user_owner_d', { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
  });

  it('update by a non-owner throws DeskViewForbiddenError', async () => {
    const view = await createDeskView(db, 'user_owner_e', {
      name: 'Owned',
      filters: emptyFilters,
      sort: 'newest',
      shared: true,
    });
    await expect(updateDeskView(db, view.id, 'user_intruder', { name: 'Hijacked' })).rejects.toThrow(
      DeskViewForbiddenError,
    );
  });

  it('update on a missing view throws DeskViewNotFoundError', async () => {
    await expect(updateDeskView(db, 'dview_missing', 'user_owner_a', { name: 'x' })).rejects.toThrow(
      DeskViewNotFoundError,
    );
  });

  it('delete by a non-owner throws DeskViewForbiddenError; owner can delete', async () => {
    const view = await createDeskView(db, 'user_owner_f', {
      name: 'To delete',
      filters: emptyFilters,
      sort: 'newest',
      shared: false,
    });
    await expect(deleteDeskView(db, view.id, 'user_intruder')).rejects.toThrow(DeskViewForbiddenError);
    await expect(deleteDeskView(db, view.id, 'user_owner_f')).resolves.toBeUndefined();
  });
});
