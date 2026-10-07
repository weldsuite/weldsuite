/**
 * WeldKnow teamspaces — who may see, read, write and manage which space.
 *
 *   personal — its owner, and nobody else. Not even a workspace admin holding
 *              `knowledge:manage`; to them the id resolves to nothing.
 *   open     — everyone (with knowledge:read) sees and reads it. Joining is one
 *              click and makes you an editor.
 *   closed   — everyone sees that it exists; only members read it. An owner
 *              adds people.
 *   private  — only members know it exists.
 *
 * Members act at their role: viewer reads, editor also writes pages, owner also
 * changes the teamspace's settings and members. `knowledge:manage`
 * (`canManageAll`) makes every teamspace visible and manageable, but reading a
 * closed or private one still takes joining it.
 *
 * The workspace permissions (knowledge:read|create|update|delete) are checked
 * on top of this by the routes: a membership never grants more than the
 * caller's role in the workspace allows.
 *
 * A workspace API key (external-api / mcp-server, `userId === null`) has no
 * person behind it and so no memberships: it sees, reads and writes open
 * teamspaces only — never a closed, private or personal space. A user token
 * follows that user's memberships exactly like the platform does.
 *
 * A space the caller cannot see is a 404, never a 403.
 *
 * Shared by know-api, external-api and mcp-server so all three answer the same.
 */

import { and, asc, count, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { KnowledgeSpaceRole } from '@weldsuite/core-api-client/schemas/knowledge';

const spaces = schema.knowledgeSpaces;
const members = schema.knowledgeSpaceMembers;
const workspaceMembers = schema.workspaceMembers;

export type SpaceRow = typeof spaces.$inferSelect;

/** The caller reached a space but may not do this to it. Answered with 403. */
export class SpaceAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpaceAccessError';
  }
}

/** The request would leave the space in a broken state. Answered with 409. */
export class SpaceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpaceConflictError';
  }
}

/** The space (or member) does not exist for this caller. Answered with 404. */
export class SpaceNotFoundError extends Error {
  constructor(
    readonly resource: string,
    readonly id: string,
  ) {
    super(`${resource} not found`);
    this.name = 'SpaceNotFoundError';
  }
}

export interface SpaceAccess {
  space: SpaceRow;
  /** The caller's membership role; `owner` for their own personal space. */
  role: KnowledgeSpaceRole | null;
  canRead: boolean;
  canWrite: boolean;
  /** Edit settings, manage members, delete. */
  canManage: boolean;
}

export interface SpaceSummary extends SpaceRow {
  role: KnowledgeSpaceRole | null;
  isMember: boolean;
  canRead: boolean;
  canWrite: boolean;
  canManage: boolean;
  memberCount: number;
}

/**
 * What this caller may do to a space, given their active membership role.
 * Null when the space is invisible to them. `userId === null` is an API key.
 */
export function accessFor(
  space: SpaceRow,
  role: KnowledgeSpaceRole | null,
  userId: string | null,
  canManageAll: boolean,
): SpaceAccess | null {
  if (userId === null) {
    if (space.kind !== 'team' || space.visibility !== 'open') return null;
    return { space, role: null, canRead: true, canWrite: true, canManage: true };
  }

  if (space.kind === 'personal') {
    if (space.ownerId !== userId) return null;
    return { space, role: 'owner', canRead: true, canWrite: true, canManage: false };
  }

  if (role) {
    return {
      space,
      role,
      canRead: true,
      canWrite: role !== 'viewer',
      canManage: role === 'owner' || canManageAll,
    };
  }

  if (space.visibility === 'private' && !canManageAll) return null;
  return {
    space,
    role: null,
    canRead: space.visibility === 'open',
    canWrite: false,
    canManage: canManageAll,
  };
}

/** Active (not left) membership row filter. */
const active = isNull(members.leftAt);

async function membershipRole(db: Database, spaceId: string, userId: string) {
  const [row] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.spaceId, spaceId), eq(members.userId, userId), active))
    .limit(1);
  return row?.role ?? null;
}

/** Resolve a live space for this caller, or throw a 404-shaped error. */
export async function requireSpace(
  db: Database,
  userId: string | null,
  spaceId: string,
  options: { canManageAll?: boolean } = {},
): Promise<SpaceAccess> {
  const [space] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), isNull(spaces.deletedAt)))
    .limit(1);
  if (!space) throw new SpaceNotFoundError('Space', spaceId);

  const role = space.kind === 'team' && userId ? await membershipRole(db, spaceId, userId) : null;
  const access = accessFor(space, role, userId, options.canManageAll ?? false);
  if (!access) throw new SpaceNotFoundError('Space', spaceId);
  return access;
}

export function assertCanRead(access: SpaceAccess): void {
  if (!access.canRead) {
    throw new SpaceAccessError('You are not a member of this teamspace. Join it to read its pages.');
  }
}

export function assertCanWrite(access: SpaceAccess): void {
  assertCanRead(access);
  if (!access.canWrite) throw new SpaceAccessError('This needs the editor role in the teamspace.');
}

export function assertCanManage(access: SpaceAccess): void {
  if (access.space.kind === 'personal') {
    throw new SpaceAccessError('Your private space cannot be renamed, shared or deleted.');
  }
  if (!access.canManage) throw new SpaceAccessError('This needs the owner role in the teamspace.');
}

/**
 * Every space the caller can see, with what they may do in each: their
 * personal space, the teamspaces they are in, open and closed teamspaces, and
 * — with `knowledge:manage` — private teamspaces too.
 */
export async function listSpaces(
  db: Database,
  userId: string | null,
  options: { canManageAll?: boolean } = {},
): Promise<SpaceSummary[]> {
  const rows = userId
    ? await db
        .select({ space: spaces, role: members.role })
        .from(spaces)
        .leftJoin(members, and(eq(members.spaceId, spaces.id), eq(members.userId, userId), active))
        .where(isNull(spaces.deletedAt))
        .orderBy(asc(spaces.sortOrder), asc(spaces.createdAt))
    : await db
        .select({ space: spaces, role: sql<KnowledgeSpaceRole | null>`null` })
        .from(spaces)
        .where(isNull(spaces.deletedAt))
        .orderBy(asc(spaces.sortOrder), asc(spaces.createdAt));

  const visible = rows
    .map((row) => accessFor(row.space, row.role ?? null, userId, options.canManageAll ?? false))
    .filter((access): access is SpaceAccess => access !== null);

  const counts = await countMembers(
    db,
    visible.filter((a) => a.space.kind === 'team').map((a) => a.space.id),
  );

  return visible.map(({ space, role, canRead, canWrite, canManage }) => ({
    ...space,
    role,
    isMember: role !== null,
    canRead,
    canWrite,
    canManage,
    memberCount: space.kind === 'personal' ? 1 : (counts.get(space.id) ?? 0),
  }));
}

async function countMembers(db: Database, spaceIds: string[]): Promise<Map<string, number>> {
  if (spaceIds.length === 0) return new Map();
  const rows = await db
    .select({ spaceId: members.spaceId, total: count() })
    .from(members)
    .where(and(inArray(members.spaceId, spaceIds), active))
    .groupBy(members.spaceId);
  return new Map(rows.map((row) => [row.spaceId, Number(row.total)]));
}

/** Ids of the spaces whose pages the caller may read. */
export async function readableSpaceIds(db: Database, userId: string | null): Promise<string[]> {
  const all = await listSpaces(db, userId);
  return all.filter((s) => s.canRead).map((s) => s.id);
}

/** Ids of the spaces the caller may write pages in. */
export async function writableSpaceIds(db: Database, userId: string | null): Promise<string[]> {
  const all = await listSpaces(db, userId);
  return all.filter((s) => s.canWrite).map((s) => s.id);
}

// ---------------------------------------------------------------------------
// Personal space + default teamspaces
// ---------------------------------------------------------------------------

/**
 * The caller's personal space, created on first use. Two tabs can race here;
 * the partial unique index on owner lets exactly one insert win.
 */
export async function ensurePersonalSpace(db: Database, userId: string): Promise<void> {
  const [existing] = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.kind, 'personal'), eq(spaces.ownerId, userId), isNull(spaces.deletedAt)))
    .limit(1);
  if (existing) return;

  const now = new Date();
  await db
    .insert(spaces)
    .values({
      id: generateId('kspc'),
      name: 'Private',
      kind: 'personal',
      ownerId: userId,
      visibility: 'private',
      sortOrder: -1,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

/** Workspace members a teamspace can be shared with: active, internal people. */
const shareable = and(
  eq(workspaceMembers.status, 'ACTIVE'),
  eq(workspaceMembers.memberType, 'INTERNAL'),
  isNull(workspaceMembers.deletedAt),
);

/**
 * Add the caller to every default teamspace they have never been in. Someone
 * who left (or was removed) keeps their `leftAt` row and is not pulled back.
 *
 * Only active, internal workspace members are added — the same people
 * `addEveryoneToSpace` adds when a teamspace is made default — so an external
 * or suspended member who reaches WeldKnow does not become an editor here.
 */
export async function joinDefaultSpaces(db: Database, userId: string): Promise<void> {
  const [eligible] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), shareable))
    .limit(1);
  if (!eligible) return;

  const missing = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(
      and(
        eq(spaces.kind, 'team'),
        eq(spaces.isDefault, true),
        isNull(spaces.deletedAt),
        notExists(
          db
            .select({ one: sql`1` })
            .from(members)
            .where(and(eq(members.spaceId, spaces.id), eq(members.userId, userId))),
        ),
      ),
    );
  if (missing.length === 0) return;

  const now = new Date();
  await db
    .insert(members)
    .values(
      missing.map((space) => ({
        id: generateId('kspm'),
        spaceId: space.id,
        userId,
        role: 'editor' as const,
        addedBy: null,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing();
}

/** Add every shareable workspace member who has never been in the space. */
export async function addEveryoneToSpace(db: Database, spaceId: string, addedBy: string): Promise<void> {
  const people = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        shareable,
        notExists(
          db
            .select({ one: sql`1` })
            .from(members)
            .where(and(eq(members.spaceId, spaceId), eq(members.userId, workspaceMembers.userId))),
        ),
      ),
    );
  if (people.length === 0) return;

  const now = new Date();
  await db
    .insert(members)
    .values(
      people.map((person) => ({
        id: generateId('kspm'),
        spaceId,
        userId: person.userId,
        role: 'editor' as const,
        addedBy,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export interface SpaceMember {
  userId: string;
  role: KnowledgeSpaceRole;
  name: string | null;
  email: string | null;
  picture: string | null;
  addedBy: string | null;
  createdAt: Date;
}

export interface Teammate {
  userId: string;
  name: string | null;
  email: string | null;
  picture: string | null;
}

export async function listTeammates(db: Database): Promise<Teammate[]> {
  return db
    .select({
      userId: workspaceMembers.userId,
      name: workspaceMembers.name,
      email: workspaceMembers.email,
      picture: workspaceMembers.picture,
    })
    .from(workspaceMembers)
    .where(shareable)
    .orderBy(asc(workspaceMembers.name), asc(workspaceMembers.email));
}

export async function listSpaceMembers(db: Database, spaceId: string): Promise<SpaceMember[]> {
  return db
    .select({
      userId: members.userId,
      role: members.role,
      name: workspaceMembers.name,
      email: workspaceMembers.email,
      picture: workspaceMembers.picture,
      addedBy: members.addedBy,
      createdAt: members.createdAt,
    })
    .from(members)
    .leftJoin(workspaceMembers, eq(workspaceMembers.userId, members.userId))
    .where(and(eq(members.spaceId, spaceId), active))
    .orderBy(asc(workspaceMembers.name), asc(members.createdAt));
}

/**
 * Add a teammate (or bring back someone who left), or change their role if
 * they are already in. The user id must belong to an active member of this
 * workspace, so a space cannot be shared with an id that belongs to nobody.
 */
export async function addSpaceMember(
  db: Database,
  spaceId: string,
  input: { userId: string; role: KnowledgeSpaceRole; addedBy: string },
): Promise<{ created: boolean }> {
  const [teammate] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, input.userId), shareable))
    .limit(1);
  if (!teammate) throw new SpaceNotFoundError('Teammate', input.userId);

  const [existing] = await db
    .select({ id: members.id, role: members.role, leftAt: members.leftAt })
    .from(members)
    .where(and(eq(members.spaceId, spaceId), eq(members.userId, input.userId)))
    .limit(1);

  const now = new Date();
  if (existing && existing.leftAt === null) {
    await setSpaceMemberRole(db, spaceId, input.userId, input.role);
    return { created: false };
  }
  if (existing) {
    await db
      .update(members)
      .set({ role: input.role, leftAt: null, addedBy: input.addedBy, updatedAt: now })
      .where(eq(members.id, existing.id));
    return { created: true };
  }

  await db
    .insert(members)
    .values({
      id: generateId('kspm'),
      spaceId,
      userId: input.userId,
      role: input.role,
      addedBy: input.addedBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  return { created: true };
}

async function requireMembership(db: Database, spaceId: string, userId: string) {
  const [row] = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.spaceId, spaceId), eq(members.userId, userId), active))
    .limit(1);
  if (!row) throw new SpaceNotFoundError('Member', userId);
  return row;
}

/** A teamspace always keeps one owner, or nobody in it could manage it again. */
async function assertNotLastOwner(db: Database, spaceId: string, userId: string): Promise<void> {
  const owners = await db
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.spaceId, spaceId), eq(members.role, 'owner'), active));
  if (owners.length === 1 && owners[0]?.userId === userId) {
    throw new SpaceConflictError('This is the teamspace’s only owner. Make someone else an owner first.');
  }
}

export async function setSpaceMemberRole(
  db: Database,
  spaceId: string,
  userId: string,
  role: KnowledgeSpaceRole,
): Promise<{ previous: KnowledgeSpaceRole }> {
  const membership = await requireMembership(db, spaceId, userId);
  if (membership.role === 'owner' && role !== 'owner') {
    await assertNotLastOwner(db, spaceId, userId);
  }
  await db.update(members).set({ role, updatedAt: new Date() }).where(eq(members.id, membership.id));
  return { previous: membership.role };
}

/** Leave, or be removed from, a teamspace. The row stays with `leftAt` set. */
export async function removeSpaceMember(db: Database, spaceId: string, userId: string): Promise<void> {
  const membership = await requireMembership(db, spaceId, userId);
  if (membership.role === 'owner') await assertNotLastOwner(db, spaceId, userId);
  const now = new Date();
  await db.update(members).set({ leftAt: now, updatedAt: now }).where(eq(members.id, membership.id));
}

/** Join an open teamspace (or, for an admin, any teamspace) as an editor. */
export async function joinSpace(db: Database, access: SpaceAccess, userId: string): Promise<void> {
  if (access.space.kind === 'personal') throw new SpaceAccessError('You cannot join a private space.');
  if (access.role) return;
  if (access.space.visibility !== 'open' && !access.canManage) {
    throw new SpaceAccessError('Ask an owner of this teamspace to add you.');
  }
  await addSpaceMember(db, access.space.id, { userId, role: 'editor', addedBy: userId });
}
