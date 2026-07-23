/**
 * pglite-backed service tests for services/desk/teams.ts — team CRUD +
 * archive-on-delete, and teammate settings upsert-on-PUT.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  archiveDeskTeam,
  createDeskTeam,
  DeskTeamNotFoundError,
  getTeammateSettings,
  listDeskTeams,
  updateDeskTeam,
  upsertTeammateSettings,
} from './teams';
import { createPgliteDb } from '../../test/pglite';
import type { Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('desk teams · pglite integration', () => {
  it('creates a team with defaults and lists it', async () => {
    const team = await createDeskTeam(db, {
      name: 'Support',
      memberIds: ['user_1', 'user_2'],
      distributionMethod: 'round_robin',
    });
    expect(team.id).toMatch(/^dteam_/);
    expect(team.archived).toBe(false);
    expect(team.distributionMethod).toBe('round_robin');

    const list = await listDeskTeams(db);
    expect(list.some((t) => t.id === team.id)).toBe(true);
  });

  it('updates a team', async () => {
    const team = await createDeskTeam(db, { name: 'Billing', memberIds: [], distributionMethod: 'manual' });
    const updated = await updateDeskTeam(db, team.id, { name: 'Billing Team', teamLimit: 10 });
    expect(updated.name).toBe('Billing Team');
    expect(updated.teamLimit).toBe(10);
  });

  it('update throws DeskTeamNotFoundError for a missing team', async () => {
    await expect(updateDeskTeam(db, 'dteam_missing', { name: 'x' })).rejects.toThrow(DeskTeamNotFoundError);
  });

  it('archive sets archived=true and excludes it from the default list', async () => {
    const team = await createDeskTeam(db, { name: 'Temp', memberIds: [], distributionMethod: 'manual' });
    const archived = await archiveDeskTeam(db, team.id);
    expect(archived.archived).toBe(true);

    const activeOnly = await listDeskTeams(db);
    expect(activeOnly.some((t) => t.id === team.id)).toBe(false);

    const withArchived = await listDeskTeams(db, { archived: true });
    expect(withArchived.some((t) => t.id === team.id)).toBe(true);
  });

  it('teammate settings: GET returns null before any PUT, then upserts on PUT', async () => {
    const userId = 'user_teammate_1';
    const before = await getTeammateSettings(db, userId);
    expect(before).toBeNull();

    const created = await upsertTeammateSettings(db, userId, { status: 'away', assignmentLimit: 5 });
    expect(created.userId).toBe(userId);
    expect(created.status).toBe('away');
    expect(created.assignmentLimit).toBe(5);

    const patched = await upsertTeammateSettings(db, userId, { status: 'active' });
    expect(patched.status).toBe('active');
    // assignmentLimit untouched by the partial PUT.
    expect(patched.assignmentLimit).toBe(5);
  });
});
