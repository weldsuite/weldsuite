import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import {
  canAccessViaFilter,
  registerEntityProvider,
  type EntityChannelProvider,
} from '../registry';

export function personDisplayName(p: {
  displayName: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}): string {
  const fromParts = `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim();
  return p.displayName || p.fullName || fromParts || p.email || 'Person';
}

/**
 * Person record chat (WeldCRM). crm-api's `/api/people/:id/chat/*` forwards
 * here.
 *
 * Visibility follows crm-api's people routes: `people:read`, and either
 * `people:scope:all` or ownership of the person. The owner and the account
 * manager follow the chat from the start.
 */
export const personEntityProvider: EntityChannelProvider = {
  type: 'person',
  label: 'People',
  requiredPermission: 'people:read',

  async resolve({ db, entityId }) {
    const { people } = schema;
    const [row] = await db
      .select({
        displayName: people.displayName,
        fullName: people.fullName,
        firstName: people.firstName,
        lastName: people.lastName,
        email: people.email,
        ownerId: people.ownerId,
        accountManagerId: people.accountManagerId,
      })
      .from(people)
      .where(and(eq(people.id, entityId), isNull(people.deletedAt)))
      .limit(1);
    if (!row) return null;

    const members = new Set<string>();
    if (row.ownerId) members.add(row.ownerId);
    if (row.accountManagerId) members.add(row.accountManagerId);
    return {
      displayName: personDisplayName(row),
      defaultMemberIds: Array.from(members),
    };
  },

  async filterVisible({ db, actingUserId, can }, entityIds) {
    if (entityIds.length === 0) return new Set();
    const { people } = schema;
    const conditions = [inArray(people.id, entityIds), isNull(people.deletedAt)];
    if (!(await can('people:scope:all'))) conditions.push(eq(people.ownerId, actingUserId));
    const rows = await db.select({ id: people.id }).from(people).where(and(...conditions));
    return new Set(rows.map((r) => r.id));
  },

  canAccess(ctx) {
    return canAccessViaFilter(personEntityProvider, ctx);
  },
};

registerEntityProvider(personEntityProvider);
