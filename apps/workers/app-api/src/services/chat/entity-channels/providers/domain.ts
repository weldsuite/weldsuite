import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '../../../../db';
import { registerEntityProvider, type EntityChannelProvider } from '../registry';
import { publicDomainRegistrar } from '@weldsuite/core-api-client/schemas/domains';

/**
 * Domain entity chat provider (WeldHost).
 *
 * The domain object panel renders an `EntityChat` in its sidebar the same way
 * the task and project panels do; without this provider the channel lookup
 * 400s with "Unknown entity type: domain" and the sidebar stays empty.
 *
 * Domains have no membership table — the acting user is the only default
 * member, and workspace-level `messages:read` (enforced in the route layer)
 * governs who else can open the channel. Same shape as the contact provider.
 */
export const domainEntityProvider: EntityChannelProvider = {
  type: 'domain',
  label: 'Domains',
  requiredPermission: 'messages:read',

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

  async canAccess({ db, entityId }) {
    // Workspace-level permission is enforced at the route layer; here we only
    // verify the domain exists and isn't soft-deleted, so we never create a
    // channel for a ghost entity.
    const { hostDomains } = schema;
    const [domain] = await db
      .select({ id: hostDomains.id })
      .from(hostDomains)
      .where(and(eq(hostDomains.id, entityId), isNull(hostDomains.deletedAt)))
      .limit(1);
    return !!domain;
  },
};

registerEntityProvider(domainEntityProvider);
