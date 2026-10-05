/**
 * Shared ownerId/accountManagerId validation for companies + people.
 *
 * The grid's Owner column lets a user pick any workspace member, but the API
 * previously accepted ANY string for `ownerId`/`accountManagerId` — a typo'd
 * or copy-pasted id would silently save and the grid would render the raw
 * (meaningless) id instead of a name. This checks the id against
 * `workspace_members` before writing it.
 *
 * A soft-deleted member no longer counts as valid (removed from the
 * workspace), but PENDING (invited, not yet accepted) still does — picking
 * someone before they accept their invite is a normal flow.
 */

import { eq, and, isNull, inArray } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

/** Every distinct, non-null member id referenced by `ownerId`/`accountManagerId`. */
function collectCandidateIds(input: {
  ownerId?: string | null;
  accountManagerId?: string | null;
}): string[] {
  const ids = [input.ownerId, input.accountManagerId].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  return Array.from(new Set(ids));
}

export class InvalidMemberIdError extends Error {
  readonly isValidationError = true as const;
  constructor(public readonly field: string, public readonly value: string) {
    super(`"${value}" is not a member of this workspace`);
    this.name = 'InvalidMemberIdError';
  }
}

/**
 * Throws `InvalidMemberIdError` if `ownerId` or `accountManagerId` is set to
 * a non-empty value that doesn't match an active workspace member. Values
 * that are `undefined` (field omitted from a partial update) or `null`
 * (explicitly cleared) are never checked.
 */
export async function assertValidMemberFields(
  db: Database,
  input: { ownerId?: string | null; accountManagerId?: string | null },
): Promise<void> {
  const ids = collectCandidateIds(input);
  if (ids.length === 0) return;

  const { workspaceMembers } = schema;
  const rows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(inArray(workspaceMembers.userId, ids), isNull(workspaceMembers.deletedAt)));
  const validIds = new Set(rows.map((r) => r.userId));

  if (input.ownerId && !validIds.has(input.ownerId)) {
    throw new InvalidMemberIdError('ownerId', input.ownerId);
  }
  if (input.accountManagerId && !validIds.has(input.accountManagerId)) {
    throw new InvalidMemberIdError('accountManagerId', input.accountManagerId);
  }
}

// Re-exported for a single-id check (bulk-update's `updates.ownerId`, which
// — unlike create/update — isn't necessarily the acting user's own field).
export async function isValidWorkspaceMember(db: Database, userId: string): Promise<boolean> {
  const { workspaceMembers } = schema;
  const [row] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
    .limit(1);
  return !!row;
}
