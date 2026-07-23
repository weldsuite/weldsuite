/**
 * WeldDesk v2 — saved inbox views service.
 *
 * Small collection per user (sidebar views) — plain array, no cursor
 * pagination. List returns the current user's own views plus shared views
 * owned by anyone else; owner-only mutation is enforced by the route
 * (mirrors the ownerId-scoping pattern used elsewhere in app-api, e.g.
 * leads' `scopeFor` owner checks) so the 403 message stays consistent.
 */

import { and, asc, eq, ne, or } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import type { DeskView } from '@weldsuite/db/schema/desk-views';
import type { CreateDeskViewInput, UpdateDeskViewInput } from '@weldsuite/core-api-client/schemas/desk-views';

const views = schema.deskViews;

export class DeskViewNotFoundError extends Error {
  constructor(id: string) {
    super(`View '${id}' not found`);
    this.name = 'DeskViewNotFoundError';
  }
}

export class DeskViewForbiddenError extends Error {
  constructor(id: string) {
    super(`Not the owner of view '${id}'`);
    this.name = 'DeskViewForbiddenError';
  }
}

/** Owned-by-me views + shared views owned by someone else. */
export async function listDeskViews(
  db: Database,
  userId: string,
  options: { folder?: string } = {},
): Promise<DeskView[]> {
  const visibility = or(eq(views.ownerId, userId), and(ne(views.ownerId, userId), eq(views.shared, true)));
  const where = options.folder ? and(visibility, eq(views.folder, options.folder)) : visibility;

  return db.select().from(views).where(where).orderBy(asc(views.order), asc(views.name));
}

export async function getDeskView(db: Database, id: string): Promise<DeskView | null> {
  const [row] = await db.select().from(views).where(eq(views.id, id)).limit(1);
  return row ?? null;
}

export async function createDeskView(
  db: Database,
  ownerId: string,
  input: CreateDeskViewInput,
): Promise<DeskView> {
  const id = generateId('dview');
  const now = new Date();
  await db.insert(views).values({
    id,
    createdAt: now,
    updatedAt: now,
    name: input.name,
    icon: input.icon ?? null,
    folder: input.folder ?? null,
    filters: input.filters,
    sort: input.sort ?? 'newest',
    shared: input.shared ?? false,
    ownerId,
    order: input.order ?? 0,
  });
  const [created] = await db.select().from(views).where(eq(views.id, id)).limit(1);
  return created!;
}

/** Throws DeskViewNotFoundError / DeskViewForbiddenError — route maps to 404/403. */
export async function updateDeskView(
  db: Database,
  id: string,
  userId: string,
  input: UpdateDeskViewInput,
): Promise<DeskView> {
  const current = await getDeskView(db, id);
  if (!current) throw new DeskViewNotFoundError(id);
  if (current.ownerId !== userId) throw new DeskViewForbiddenError(id);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.folder !== undefined) patch.folder = input.folder;
  if (input.filters !== undefined) patch.filters = input.filters;
  if (input.sort !== undefined) patch.sort = input.sort;
  if (input.shared !== undefined) patch.shared = input.shared;
  if (input.order !== undefined) patch.order = input.order;

  await db.update(views).set(patch).where(eq(views.id, id));
  const [updated] = await db.select().from(views).where(eq(views.id, id)).limit(1);
  return updated!;
}

export async function deleteDeskView(db: Database, id: string, userId: string): Promise<void> {
  const current = await getDeskView(db, id);
  if (!current) throw new DeskViewNotFoundError(id);
  if (current.ownerId !== userId) throw new DeskViewForbiddenError(id);
  await db.delete(views).where(eq(views.id, id));
}
