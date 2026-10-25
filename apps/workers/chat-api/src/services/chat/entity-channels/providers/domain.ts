import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import {
  canAccessViaFilter,
  registerEntityProvider,
  type EntityChannelProvider,
} from '../registry';
import { publicDomainRegistrar } from '@weldsuite/core-api-client/schemas/domains';

/**
 * Domain entity chat provider (WeldHost).
 *
 * The domain object panel renders an `EntityChat` in its sidebar the same way
 * the task and project panels do; without this provider the channel lookup
 * 400s with "Unknown entity type: domain" and the sidebar stays empty.
 *
 * Domains have no membership table: anyone with `domains:read` may see a live
 * domain, and only the acting user follows a new chat.
 */
export const domainEntityProvider: EntityChannelProvider = {
  type: 'domain',
  label: 'Domains',
  requiredPermission: 'domains:read',

  async resolve({ db, entityId, actingUserId }) {
    const { hostDomains } = schema;
    const [domain] = await db
      .select({ fullDomain: hostDomains.fullDomain })
      .from(hostDomains)
      .where(and(eq(hostDomains.id, entityId), isNull(hostDomains.deletedAt)))
      .limit(1);

    if (!domain) return null;

    return {
      displayName: domain.fullDomain,
      defaultMemberIds: [actingUserId],
    };
  },

  async resolveDetail({ db, entityId }) {
    const { hostDomains } = schema;
    const [domain] = await db
      .select({
        id: hostDomains.id,
        name: hostDomains.name,
        tld: hostDomains.tld,
        fullDomain: hostDomains.fullDomain,
        status: hostDomains.status,
        registrar: hostDomains.registrar,
        registeredAt: hostDomains.registeredAt,
        expiresAt: hostDomains.expiresAt,
        autoRenew: hostDomains.autoRenew,
        nameservers: hostDomains.nameservers,
      })
      .from(hostDomains)
      .where(and(eq(hostDomains.id, entityId), isNull(hostDomains.deletedAt)))
      .limit(1);
    return domain
      ? { ...domain, registrar: publicDomainRegistrar(domain.registrar) }
      : null;
  },

  async filterVisible({ db }, entityIds) {
    if (entityIds.length === 0) return new Set();
    const { hostDomains } = schema;
    const rows = await db
      .select({ id: hostDomains.id })
      .from(hostDomains)
      .where(and(inArray(hostDomains.id, entityIds), isNull(hostDomains.deletedAt)));
    return new Set(rows.map((r) => r.id));
  },

  canAccess(ctx) {
    return canAccessViaFilter(domainEntityProvider, ctx);
  },
};

registerEntityProvider(domainEntityProvider);
