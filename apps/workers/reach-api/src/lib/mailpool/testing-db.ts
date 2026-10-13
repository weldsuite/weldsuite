/**
 * Database fixtures for tests that run against pglite (tenant) and the pglite
 * master DB. Used only by `*.test.ts`; never imported by worker code.
 */

import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { sealWarmupCredentials } from '@weldsuite/reach-domain/warmup-pool';

/** 64 hex characters: a valid WELDREACH_WARMUP_KEY for tests. */
export const WARMUP_TEST_KEY = '1f'.repeat(32);

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
  await master.delete(masterSchema.reachWarmupMessages);
  await master.delete(masterSchema.reachWarmupMailboxes);
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

type PoolStats = NonNullable<typeof masterSchema.reachWarmupMailboxes.$inferInsert['stats']>;

/** Pool stats with everything zero, overridable. */
export function poolStats(overrides: Partial<PoolStats> = {}): PoolStats {
  return {
    sent7d: 0,
    received7d: 0,
    inbox3d: 0,
    spam3d: 0,
    missing3d: 0,
    inbox7d: 0,
    spam7d: 0,
    missing7d: 0,
    inboxRate3d: null,
    inboxRate7d: null,
    spamRescues7d: 0,
    rolledUpAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A row of the master warmup pool (what reach-api registers and the warmup
 * worker updates), for tenant mailbox `tenantMailboxId`. Logins are sealed with
 * WARMUP_TEST_KEY.
 */
export async function seedPoolMailbox(
  master: MasterDatabase,
  fixture: Partial<typeof masterSchema.reachWarmupMailboxes.$inferInsert> & { tenantMailboxId: string },
) {
  const email = fixture.email ?? `${fixture.tenantMailboxId}@getacme.com`;
  const login = { host: 'smtp.mailpool.test', port: 465, tls: true, username: email, password: 'pool-secret' };
  const [row] = await master
    .insert(masterSchema.reachWarmupMailboxes)
    .values({
      id: `rwmb_${fixture.tenantMailboxId}`.slice(0, 30),
      workspaceId: 'ws_acme',
      clerkOrgId: 'org_acme',
      email,
      domain: email.split('@')[1] ?? 'getacme.com',
      mailboxType: 'google',
      firstName: 'Jane',
      lastName: 'Doe',
      smtpCredentials: await sealWarmupCredentials({ WELDREACH_WARMUP_KEY: WARMUP_TEST_KEY }, login),
      imapCredentials: await sealWarmupCredentials({ WELDREACH_WARMUP_KEY: WARMUP_TEST_KEY }, { ...login, host: 'imap.mailpool.test', port: 993 }),
      ...fixture,
    })
    .returning();
  return row!;
}

/** A warmup message in master (what the planner schedules and the inbound filter looks up). */
export async function seedWarmupMessage(
  master: MasterDatabase,
  fixture: { messageIdHeader: string } & Partial<typeof masterSchema.reachWarmupMessages.$inferInsert>,
) {
  const [row] = await master
    .insert(masterSchema.reachWarmupMessages)
    .values({
      id: generateId('rwms'),
      threadId: 'rwth_1',
      fromMailboxId: 'rwmb_a',
      toMailboxId: 'rwmb_b',
      corpusThreadId: 'corpus_1',
      subject: 'Quick question about the Q3 numbers',
      status: 'sent',
      scheduledAt: new Date('2026-10-12T09:00:00Z'),
      ...fixture,
    })
    .returning();
  return row!;
}
