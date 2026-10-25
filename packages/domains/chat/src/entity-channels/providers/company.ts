import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import {
  canAccessViaFilter,
  registerEntityProvider,
  type EntityChannelProvider,
} from '../registry';

/**
 * Company record chat (WeldCRM). crm-api's `/api/companies/:id/chat/*` forwards
 * here.
 *
 * Visibility follows crm-api's company routes: `companies:read`, and either
 * `companies:scope:all` or ownership of the company. The owner and the account
 * manager follow the chat from the start.
 */
export const companyEntityProvider: EntityChannelProvider = {
  type: 'company',
  label: 'Companies',
  requiredPermission: 'companies:read',

  async resolve({ db, entityId }) {
    const { companies } = schema;
    const [row] = await db
      .select({
        displayName: companies.displayName,
        name: companies.name,
        ownerId: companies.ownerId,
        accountManagerId: companies.accountManagerId,
      })
      .from(companies)
      .where(and(eq(companies.id, entityId), isNull(companies.deletedAt)))
      .limit(1);
    if (!row) return null;

    const members = new Set<string>();
    if (row.ownerId) members.add(row.ownerId);
    if (row.accountManagerId) members.add(row.accountManagerId);
    return {
      displayName: row.displayName || row.name || 'Company',
      defaultMemberIds: Array.from(members),
    };
  },

  async filterVisible({ db, actingUserId, can }, entityIds) {
    if (entityIds.length === 0) return new Set();
    const { companies } = schema;
    const conditions = [inArray(companies.id, entityIds), isNull(companies.deletedAt)];
    if (!(await can('companies:scope:all'))) conditions.push(eq(companies.ownerId, actingUserId));
    const rows = await db.select({ id: companies.id }).from(companies).where(and(...conditions));
    return new Set(rows.map((r) => r.id));
  },

  canAccess(ctx) {
    return canAccessViaFilter(companyEntityProvider, ctx);
  },
};

registerEntityProvider(companyEntityProvider);
