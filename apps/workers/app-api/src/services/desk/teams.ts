/**
 * WeldDesk v2 — team inbox + teammate settings service.
 *
 * Teams are small collections (a handful per workspace) — no cursor
 * pagination, just a plain array sorted by name (mirrors how
 * departments/agents-style small-collection routes behave elsewhere in
 * app-api).
 */

import { asc, eq } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import type { DeskTeam, DeskTeammateSettings } from '@weldsuite/db/schema/desk-teams';
import type {
  CreateDeskTeamInput,
  UpdateDeskTeamInput,
  UpdateTeammateSettingsInput,
} from '@weldsuite/core-api-client/schemas/desk-teams';

const teams = schema.deskTeams;
const teammateSettings = schema.deskTeammateSettings;

export class DeskTeamNotFoundError extends Error {
  constructor(id: string) {
    super(`Team '${id}' not found`);
    this.name = 'DeskTeamNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Teams CRUD
// ---------------------------------------------------------------------------

export async function listDeskTeams(db: Database, options: { archived?: boolean } = {}): Promise<DeskTeam[]> {
  const includeArchived = options.archived ?? false;
  const rows = await db.select().from(teams).orderBy(asc(teams.name));
  return includeArchived ? rows : rows.filter((row) => !row.archived);
}

export async function getDeskTeam(db: Database, id: string): Promise<DeskTeam | null> {
  const [row] = await db.select().from(teams).where(eq(teams.id, id)).limit(1);
  return row ?? null;
}

export async function createDeskTeam(db: Database, input: CreateDeskTeamInput): Promise<DeskTeam> {
  const id = generateId('dteam');
  const now = new Date();
  await db.insert(teams).values({
    id,
    createdAt: now,
    updatedAt: now,
    name: input.name,
    icon: input.icon ?? null,
    memberIds: input.memberIds ?? [],
    distributionMethod: input.distributionMethod ?? 'manual',
    teamLimit: input.teamLimit ?? null,
    ignoreAwayStatus: input.ignoreAwayStatus ?? false,
    officeHours: input.officeHours ?? null,
    expectedReplyTime: input.expectedReplyTime ?? null,
    inboxRank: input.inboxRank ?? 0,
    archived: false,
  });
  const [created] = await db.select().from(teams).where(eq(teams.id, id)).limit(1);
  return created!;
}

export async function updateDeskTeam(
  db: Database,
  id: string,
  input: UpdateDeskTeamInput,
): Promise<DeskTeam> {
  const [current] = await db.select().from(teams).where(eq(teams.id, id)).limit(1);
  if (!current) throw new DeskTeamNotFoundError(id);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.memberIds !== undefined) patch.memberIds = input.memberIds;
  if (input.distributionMethod !== undefined) patch.distributionMethod = input.distributionMethod;
  if (input.teamLimit !== undefined) patch.teamLimit = input.teamLimit;
  if (input.ignoreAwayStatus !== undefined) patch.ignoreAwayStatus = input.ignoreAwayStatus;
  if (input.officeHours !== undefined) patch.officeHours = input.officeHours;
  if (input.expectedReplyTime !== undefined) patch.expectedReplyTime = input.expectedReplyTime;
  if (input.inboxRank !== undefined) patch.inboxRank = input.inboxRank;

  await db.update(teams).set(patch).where(eq(teams.id, id));
  const [updated] = await db.select().from(teams).where(eq(teams.id, id)).limit(1);
  return updated!;
}

/** Archive (soft-delete) — teams are never hard-deleted. */
export async function archiveDeskTeam(db: Database, id: string): Promise<DeskTeam> {
  const [current] = await db.select().from(teams).where(eq(teams.id, id)).limit(1);
  if (!current) throw new DeskTeamNotFoundError(id);
  await db.update(teams).set({ archived: true, updatedAt: new Date() }).where(eq(teams.id, id));
  const [updated] = await db.select().from(teams).where(eq(teams.id, id)).limit(1);
  return updated!;
}

// ---------------------------------------------------------------------------
// Teammate settings ("me")
// ---------------------------------------------------------------------------

export async function getTeammateSettings(db: Database, userId: string): Promise<DeskTeammateSettings | null> {
  const [row] = await db
    .select()
    .from(teammateSettings)
    .where(eq(teammateSettings.userId, userId))
    .limit(1);
  return row ?? null;
}

/** Upsert-on-PUT: creates the row on first write, otherwise patches it. */
export async function upsertTeammateSettings(
  db: Database,
  userId: string,
  input: UpdateTeammateSettingsInput,
): Promise<DeskTeammateSettings> {
  const existing = await getTeammateSettings(db, userId);

  if (!existing) {
    const id = generateId('dtmset');
    const now = new Date();
    await db.insert(teammateSettings).values({
      id,
      createdAt: now,
      updatedAt: now,
      userId,
      status: input.status ?? 'active',
      assignmentLimit: input.assignmentLimit ?? null,
      lastAssignedAt: null,
      notificationPreferences: input.notificationPreferences ?? null,
    });
    const [created] = await db.select().from(teammateSettings).where(eq(teammateSettings.userId, userId)).limit(1);
    return created!;
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.status !== undefined) patch.status = input.status;
  if (input.assignmentLimit !== undefined) patch.assignmentLimit = input.assignmentLimit;
  if (input.notificationPreferences !== undefined) patch.notificationPreferences = input.notificationPreferences;

  await db.update(teammateSettings).set(patch).where(eq(teammateSettings.userId, userId));
  const [updated] = await db.select().from(teammateSettings).where(eq(teammateSettings.userId, userId)).limit(1);
  return updated!;
}
