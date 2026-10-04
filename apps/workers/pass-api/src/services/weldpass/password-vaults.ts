/**
 * Password-manager vaults and who may open them.
 *
 * Developer vault projects (`vault.ts`) are opened by workspace permission.
 * These are opened by *membership*, and every route goes through
 * `requireVaultAccess` first:
 *
 *   personal vault — its owner, and nobody else. A workspace admin holding
 *                    `passwords:manage` does not get in either; to them the id
 *                    resolves to nothing.
 *   shared vault   — the people in `weldpass_vault_members`, at their role.
 *                    `passwords:manage` can see that the vault exists and fix
 *                    its membership (so a vault whose only manager left is
 *                    recoverable), but reading an item still takes being a
 *                    member, and joining is written to the trail.
 *
 * A vault the caller cannot see is a 404, never a 403 — nothing is confirmed
 * to exist.
 */

import { and, asc, count, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { WeldPassVaultRole } from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import { createVaultKey, unwrapVaultKey, type RootKeyring } from './envelope';
import { VaultNotFoundError } from './vault';

const vaults = schema.weldpassVaults;
const members = schema.weldpassVaultMembers;
const items = schema.weldpassItems;
const workspaceMembers = schema.workspaceMembers;

const ROLE_RANK: Record<WeldPassVaultRole, number> = { viewer: 1, editor: 2, manager: 3 };

/** The caller reached a vault but may not do this to it. Answered with 403. */
export class VaultAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultAccessError';
  }
}

/** The request is well-formed but would leave the vault in a broken state. 409. */
export class VaultConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultConflictError';
  }
}

/** Vault columns safe to hand a client — the wrapped key stays server-side. */
const vaultColumns = {
  id: vaults.id,
  kind: vaults.kind,
  ownerId: vaults.ownerId,
  name: vaults.name,
  description: vaults.description,
  createdBy: vaults.createdBy,
  createdAt: vaults.createdAt,
  updatedAt: vaults.updatedAt,
};

export interface PasswordVault {
  id: string;
  kind: 'personal' | 'shared';
  ownerId: string | null;
  name: string;
  description: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VaultAccess {
  vault: PasswordVault;
  /**
   * The caller's role, or null for a workspace admin looking at a shared vault
   * they are not a member of.
   */
  role: WeldPassVaultRole | null;
}

export interface VaultSummary extends PasswordVault {
  role: WeldPassVaultRole | null;
  itemCount: number;
  memberCount: number;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * Resolve a vault for this caller, or throw a 404-shaped error.
 *
 * `canManageAll` is the caller holding `passwords:manage`. It widens which
 * shared vaults resolve; it never opens a personal vault.
 */
export async function requireVaultAccess(
  db: Database,
  workspaceId: string,
  userId: string,
  vaultId: string,
  options: { canManageAll?: boolean } = {},
): Promise<VaultAccess> {
  const [vault] = await db
    .select(vaultColumns)
    .from(vaults)
    .where(
      and(eq(vaults.id, vaultId), eq(vaults.workspaceId, workspaceId), isNull(vaults.deletedAt)),
    )
    .limit(1);

  if (!vault) throw new VaultNotFoundError('vault', vaultId);

  if (vault.kind === 'personal') {
    if (vault.ownerId !== userId) throw new VaultNotFoundError('vault', vaultId);
    return { vault, role: 'manager' };
  }

  const [membership] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.vaultId, vaultId), eq(members.userId, userId)))
    .limit(1);

  if (membership) return { vault, role: membership.role };
  if (options.canManageAll) return { vault, role: null };
  throw new VaultNotFoundError('vault', vaultId);
}

/** Require at least `minimum` on a vault the caller already resolved. */
export function assertVaultRole(access: VaultAccess, minimum: WeldPassVaultRole): void {
  if (access.role === null) {
    throw new VaultAccessError(
      'You are not a member of this vault. Add yourself as a member to open it.',
    );
  }
  if (ROLE_RANK[access.role] < ROLE_RANK[minimum]) {
    throw new VaultAccessError(`This needs the ${minimum} role on the vault.`);
  }
}

/**
 * Whether the caller may administer the vault itself — rename it, delete it,
 * change who is in it. A manager of the vault, or a workspace admin holding
 * `passwords:manage` (`canManageAll`).
 */
export function assertVaultAdmin(access: VaultAccess, canManageAll: boolean): void {
  if (access.vault.kind === 'personal') {
    throw new VaultAccessError('A personal vault cannot be shared, renamed or deleted.');
  }
  if (access.role !== 'manager' && !canManageAll) {
    throw new VaultAccessError('This needs the manager role on the vault.');
  }
}

/** Unwrap a vault's KEK for the lifetime of one request. */
export async function openPasswordVault(
  db: Database,
  keyring: RootKeyring,
  vaultId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const [row] = await db
    .select({ kekWrapped: vaults.kekWrapped })
    .from(vaults)
    .where(eq(vaults.id, vaultId))
    .limit(1);
  if (!row) throw new VaultNotFoundError('vault', vaultId);
  return unwrapVaultKey(keyring, vaultId, row.kekWrapped);
}

// ---------------------------------------------------------------------------
// Vaults
// ---------------------------------------------------------------------------

/**
 * The caller's personal vault, created on first use.
 *
 * Two tabs can race here. The partial unique index on (workspace, owner) lets
 * exactly one insert win; the loser's is dropped and both read the same row.
 */
export async function ensurePersonalVault(
  db: Database,
  workspaceId: string,
  keyring: RootKeyring,
  userId: string,
): Promise<PasswordVault> {
  const personal = and(
    eq(vaults.workspaceId, workspaceId),
    eq(vaults.kind, 'personal'),
    eq(vaults.ownerId, userId),
    isNull(vaults.deletedAt),
  );

  const [existing] = await db.select(vaultColumns).from(vaults).where(personal).limit(1);
  if (existing) return existing;

  const id = generateId('wpk');
  const key = await createVaultKey(keyring, id);
  await db
    .insert(vaults)
    .values({
      id,
      workspaceId,
      kind: 'personal',
      ownerId: userId,
      name: 'Personal',
      kekWrapped: key.kekWrapped,
      rootKeyVersion: key.rootKeyVersion,
      createdBy: userId,
    })
    .onConflictDoNothing();

  const [row] = await db.select(vaultColumns).from(vaults).where(personal).limit(1);
  if (!row) throw new VaultNotFoundError('vault', id);
  return row;
}

/**
 * Every vault the caller can see: their personal vault, the shared vaults they
 * are a member of and — with `passwords:manage` — the rest of the workspace's
 * shared vaults, reported with a null role.
 */
export async function listVaults(
  db: Database,
  workspaceId: string,
  userId: string,
  options: { canManageAll?: boolean } = {},
): Promise<VaultSummary[]> {
  const rows = await db
    .select({ ...vaultColumns, role: members.role })
    .from(vaults)
    .leftJoin(members, and(eq(members.vaultId, vaults.id), eq(members.userId, userId)))
    .where(
      and(
        eq(vaults.workspaceId, workspaceId),
        isNull(vaults.deletedAt),
        or(
          and(eq(vaults.kind, 'personal'), eq(vaults.ownerId, userId)),
          and(
            eq(vaults.kind, 'shared'),
            options.canManageAll ? undefined : sql`${members.id} IS NOT NULL`,
          ),
        ),
      ),
    )
    .orderBy(asc(vaults.name));

  const ids = rows.map((row) => row.id);
  const [itemCounts, memberCounts] = await Promise.all([countItems(db, ids), countMembers(db, ids)]);

  const summaries = rows.map((row) => ({
    ...row,
    role: row.kind === 'personal' ? ('manager' as const) : row.role,
    itemCount: itemCounts.get(row.id) ?? 0,
    memberCount: row.kind === 'personal' ? 1 : (memberCounts.get(row.id) ?? 0),
  }));

  // Personal first, then shared by name.
  return summaries.sort((a, b) => Number(b.kind === 'personal') - Number(a.kind === 'personal'));
}

async function countItems(db: Database, vaultIds: string[]): Promise<Map<string, number>> {
  if (vaultIds.length === 0) return new Map();
  const rows = await db
    .select({ vaultId: items.vaultId, total: count() })
    .from(items)
    .where(and(inArray(items.vaultId, vaultIds), isNull(items.deletedAt)))
    .groupBy(items.vaultId);
  return new Map(rows.map((row) => [row.vaultId, Number(row.total)]));
}

async function countMembers(db: Database, vaultIds: string[]): Promise<Map<string, number>> {
  if (vaultIds.length === 0) return new Map();
  const rows = await db
    .select({ vaultId: members.vaultId, total: count() })
    .from(members)
    .where(inArray(members.vaultId, vaultIds))
    .groupBy(members.vaultId);
  return new Map(rows.map((row) => [row.vaultId, Number(row.total)]));
}

/** Create a shared vault. Its creator is its first manager. */
export async function createSharedVault(
  db: Database,
  workspaceId: string,
  keyring: RootKeyring,
  input: { name: string; description?: string | null; createdBy: string },
): Promise<PasswordVault> {
  const id = generateId('wpk');
  const key = await createVaultKey(keyring, id);

  const [vault] = await db
    .insert(vaults)
    .values({
      id,
      workspaceId,
      kind: 'shared',
      ownerId: null,
      name: input.name,
      description: input.description ?? null,
      kekWrapped: key.kekWrapped,
      rootKeyVersion: key.rootKeyVersion,
      createdBy: input.createdBy,
    })
    .returning(vaultColumns);

  await db.insert(members).values({
    id: generateId('wpm'),
    vaultId: id,
    userId: input.createdBy,
    role: 'manager',
    addedBy: input.createdBy,
  });

  return vault;
}

export async function updateVault(
  db: Database,
  vaultId: string,
  patch: { name?: string; description?: string | null },
): Promise<PasswordVault> {
  const [row] = await db
    .update(vaults)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(vaults.id, vaultId))
    .returning(vaultColumns);
  return row;
}

/**
 * Soft-delete a shared vault and everything in it. The items stay encrypted in
 * place, so a mistaken delete is recoverable by clearing `deleted_at`; the
 * membership rows are kept for the same reason.
 */
export async function deleteVault(db: Database, vaultId: string): Promise<void> {
  const now = new Date();
  await db
    .update(items)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(items.vaultId, vaultId), isNull(items.deletedAt)));
  await db.update(vaults).set({ deletedAt: now, updatedAt: now }).where(eq(vaults.id, vaultId));
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export interface VaultMember {
  userId: string;
  role: WeldPassVaultRole;
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

/** Workspace members a vault can be shared with: active, internal people. */
const shareable = and(
  eq(workspaceMembers.status, 'ACTIVE'),
  eq(workspaceMembers.memberType, 'INTERNAL'),
  isNull(workspaceMembers.deletedAt),
);

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

export async function listVaultMembers(db: Database, vaultId: string): Promise<VaultMember[]> {
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
    .where(eq(members.vaultId, vaultId))
    .orderBy(asc(workspaceMembers.name), asc(members.createdAt));
}

/**
 * Add a teammate, or change their role if they are already in the vault.
 *
 * The user id is checked against this workspace's members first: without that,
 * a vault could be shared with an id that belongs to nobody here and would
 * silently start working the day that person is invited.
 */
export async function addVaultMember(
  db: Database,
  vaultId: string,
  input: { userId: string; role: WeldPassVaultRole; addedBy: string },
): Promise<{ created: boolean }> {
  const [teammate] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, input.userId), shareable))
    .limit(1);
  if (!teammate) throw new VaultNotFoundError('vault member', input.userId);

  const [existing] = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.vaultId, vaultId), eq(members.userId, input.userId)))
    .limit(1);

  if (existing) {
    await setVaultMemberRole(db, vaultId, input.userId, input.role);
    return { created: false };
  }

  await db
    .insert(members)
    .values({
      id: generateId('wpm'),
      vaultId,
      userId: input.userId,
      role: input.role,
      addedBy: input.addedBy,
    })
    .onConflictDoNothing();
  return { created: true };
}

async function requireMembership(db: Database, vaultId: string, userId: string) {
  const [row] = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.vaultId, vaultId), eq(members.userId, userId)))
    .limit(1);
  if (!row) throw new VaultNotFoundError('vault member', userId);
  return row;
}

/** A vault always keeps one manager, or nobody could ever change it again. */
async function assertNotLastManager(db: Database, vaultId: string, userId: string): Promise<void> {
  const managers = await db
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.vaultId, vaultId), eq(members.role, 'manager')));
  if (managers.length === 1 && managers[0].userId === userId) {
    throw new VaultConflictError(
      'This is the vault’s only manager. Make someone else a manager first.',
    );
  }
}

export async function setVaultMemberRole(
  db: Database,
  vaultId: string,
  userId: string,
  role: WeldPassVaultRole,
): Promise<{ previous: WeldPassVaultRole }> {
  const membership = await requireMembership(db, vaultId, userId);
  if (membership.role === 'manager' && role !== 'manager') {
    await assertNotLastManager(db, vaultId, userId);
  }
  await db
    .update(members)
    .set({ role, updatedAt: new Date() })
    .where(eq(members.id, membership.id));
  return { previous: membership.role };
}

export async function removeVaultMember(
  db: Database,
  vaultId: string,
  userId: string,
): Promise<void> {
  const membership = await requireMembership(db, vaultId, userId);
  if (membership.role === 'manager') await assertNotLastManager(db, vaultId, userId);
  await db.delete(members).where(eq(members.id, membership.id));
}
