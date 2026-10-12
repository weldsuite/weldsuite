/**
 * Database fixtures for tests that run against pglite (tenant) and the pglite
 * master DB. Used only by `*.test.ts`; never imported by worker code.
 */

import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';

export type ReachMailboxInsert = typeof schema.reachMailboxes.$inferInsert;

/** Empty every table the account services touch (tests share one pglite per file). */
export async function resetReachTenant(db: Database): Promise<void> {
  await db.delete(schema.reachEnrollments);
  await db.delete(schema.reachCampaignMailboxes);
  await db.delete(schema.reachMessages);
  await db.delete(schema.reachMailboxes);
  await db.delete(schema.reachDomains);
  await db.delete(schema.reachSettings);
  await db.delete(schema.hostDnsZones);
  await db.delete(schema.hostDomains);
}

export async function resetReachMaster(master: MasterDatabase): Promise<void> {
  await master.delete(masterSchema.reachRoutes);
}

export interface HostDomainFixture {
  id: string;
  fullDomain: string;
  status?: 'active' | 'pending' | 'expired' | 'suspended' | 'cancelled';
  registrar?: string | null;
  /** A DNS zone row at this provider; null = no zone. Default: Cloudflare. */
  zoneProvider?: 'cloudflare' | 'hetzner' | null;
  nameserverVerified?: boolean;
  expiresAt?: Date | null;
}

/** A WeldHost domain (tenant `domains` table), by default active with a Cloudflare zone. */
export async function seedHostDomain(db: Database, fixture: HostDomainFixture): Promise<void> {
  const [name, ...tld] = fixture.fullDomain.split('.');
  await db.insert(schema.hostDomains).values({
    id: fixture.id,
    name: name ?? fixture.fullDomain,
    tld: tld.join('.') || 'com',
    fullDomain: fixture.fullDomain,
    status: fixture.status ?? 'active',
    registrar: fixture.registrar ?? null,
    nameserverVerified: fixture.nameserverVerified ?? false,
    expiresAt: fixture.expiresAt ?? null,
  });
  const provider = fixture.zoneProvider === undefined ? 'cloudflare' : fixture.zoneProvider;
  if (provider) {
    await db.insert(schema.hostDnsZones).values({
      id: `zone_${fixture.id}`,
      domainId: fixture.id,
      name: fixture.fullDomain,
      status: 'active',
      provider,
      externalZoneId: `cfzone_${fixture.id}`,
    });
  }
}

export interface ReachDomainFixture {
  id: string;
  hostDomainId: string;
  name: string;
  status?: 'connecting' | 'active' | 'error' | 'disconnecting';
  mailpoolDomainId?: string | null;
}

export async function seedReachDomain(db: Database, fixture: ReachDomainFixture) {
  const [row] = await db
    .insert(schema.reachDomains)
    .values({
      id: fixture.id,
      hostDomainId: fixture.hostDomainId,
      name: fixture.name,
      status: fixture.status ?? 'active',
      mailpoolDomainId: fixture.mailpoolDomainId === undefined ? '5001' : fixture.mailpoolDomainId,
      connectedAt: new Date('2026-10-01T00:00:00Z'),
    })
    .returning();
  return row!;
}

export async function seedMailbox(
  db: Database,
  fixture: Partial<ReachMailboxInsert> & { id: string; domainId: string },
) {
  const [row] = await db
    .insert(schema.reachMailboxes)
    .values({
      email: `${fixture.id}@getacme.com`,
      firstName: 'Jane',
      lastName: 'Doe',
      type: 'google',
      status: 'active',
      mailpoolMailboxId: `mp_${fixture.id}`,
      inboundToken: `token${fixture.id}`.replaceAll('_', ''),
      ...fixture,
    })
    .returning();
  return row!;
}
