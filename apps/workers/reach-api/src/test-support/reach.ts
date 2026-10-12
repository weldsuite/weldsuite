/**
 * Fixtures for the pglite-backed send-engine and route tests: a reset between
 * tests, and seeders with sensible defaults.
 */

import type { Database } from '@weldsuite/worker-kit';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  reachCampaignMailboxes,
  reachCampaigns,
  reachCampaignSteps,
  reachEnrollments,
  reachMailboxes,
  reachMessages,
  reachProspectListMembers,
  reachProspectLists,
  reachProspects,
  reachSettings,
  reachSuppressions,
  type NewReachCampaign,
  type NewReachEnrollment,
  type NewReachMailbox,
  type NewReachProspect,
  type ReachCampaign,
  type ReachCampaignStep,
  type ReachEnrollment,
  type ReachMailbox,
  type ReachProspect,
} from '@weldsuite/db/schema';
import { sealMailServerCredentials } from '../lib/credentials';
import type { Env } from '../types';

/** 64 hex chars: a valid AES-256 key for the credentials envelope. */
export const TEST_ENCRYPTION_KEY = `${'0'.repeat(63)}1`;

export interface QueueSpy<T> {
  send: (message: T) => Promise<void>;
  sent: T[];
}

export function queueSpy<T>(): QueueSpy<T> {
  const sent: T[] = [];
  return {
    sent,
    send: async (message: T) => {
      sent.push(message);
    },
  };
}

export function testEnv(overrides: Partial<Env> = {}): Env & { events: QueueSpy<unknown> } {
  const events = queueSpy<unknown>();
  return {
    ENVIRONMENT: 'test',
    DATABASE_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    ENTITY_EVENTS: events as unknown as Env['ENTITY_EVENTS'],
    events,
    ...overrides,
  } as unknown as Env & { events: QueueSpy<unknown> };
}

/** Empty every reach table (children first). */
export async function resetReach(db: Database): Promise<void> {
  await db.delete(reachMessages);
  await db.delete(reachEnrollments);
  await db.delete(reachCampaignMailboxes);
  await db.delete(reachCampaignSteps);
  await db.delete(reachCampaigns);
  await db.delete(reachProspectListMembers);
  await db.delete(reachProspectLists);
  await db.delete(reachProspects);
  await db.delete(reachSuppressions);
  await db.delete(reachMailboxes);
  await db.delete(reachSettings);
}

export async function seedSettings(
  db: Database,
  overrides: Partial<typeof reachSettings.$inferInsert> = {},
): Promise<void> {
  await db.insert(reachSettings).values({
    id: generateId('rset'),
    senderCompanyName: 'Acme BV',
    senderAddress: 'Keizersgracht 1, Amsterdam',
    ...overrides,
  });
}

/** A short random lowercase-hex token, for seeded addresses and ids that must not collide. */
function randomToken(length: number): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, length);
}

let mailboxCounter = 0;

export async function seedMailbox(
  db: Database,
  overrides: Partial<NewReachMailbox> & { password?: string; port?: number } = {},
): Promise<ReachMailbox> {
  mailboxCounter += 1;
  const { password, port, ...rest } = overrides;
  const email = rest.email ?? `sam${mailboxCounter}@getacme.com`;
  const [row] = await db
    .insert(reachMailboxes)
    .values({
      id: generateId('rmbx'),
      domainId: 'rdom_test',
      email,
      firstName: 'Sam',
      lastName: 'Taylor',
      type: 'shared',
      status: 'active',
      dailyCap: 30,
      rampCurrent: 30,
      inboundToken: `tok${mailboxCounter}${randomToken(8)}`,
      smtpCredentials: await sealMailServerCredentials(
        { DATABASE_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY },
        { host: 'smtp.mailpool.test', port: port ?? 465, tls: true, username: email, password: password ?? 'pw' },
      ),
      ...rest,
    })
    .returning();
  return row as ReachMailbox;
}

export async function seedProspect(db: Database, overrides: Partial<NewReachProspect> = {}): Promise<ReachProspect> {
  const email = overrides.email ?? `lead${randomToken(8)}@bigco.io`;
  const [row] = await db
    .insert(reachProspects)
    .values({
      id: generateId('rpro'),
      email,
      companyDomain: email.split('@')[1] ?? null,
      firstName: 'Jane',
      lastName: 'Doe',
      companyName: 'BigCo',
      ...overrides,
    })
    .returning();
  return row as ReachProspect;
}

export interface StepSeed {
  subject: string;
  body: string;
  delayDays?: number;
  delayHours?: number;
  replyInThread?: boolean;
}

export async function seedCampaign(
  db: Database,
  options: {
    campaign?: Partial<NewReachCampaign>;
    steps?: StepSeed[];
    mailboxIds?: string[];
  } = {},
): Promise<{ campaign: ReachCampaign; steps: ReachCampaignStep[] }> {
  const [campaign] = await db
    .insert(reachCampaigns)
    .values({
      id: generateId('rcmp'),
      name: 'Test campaign',
      status: 'active',
      timezone: 'UTC',
      sendDays: [1, 2, 3, 4, 5, 6, 7],
      windowStart: '00:00',
      windowEnd: '23:59',
      dailyLimit: 100,
      minGapMinutes: 8,
      ...options.campaign,
    })
    .returning();
  const stepSeeds = options.steps ?? [
    { subject: 'Hello {{firstName}}', body: 'Hi {{firstName}}, quick question about {{companyName}}.' },
  ];
  const steps: ReachCampaignStep[] = [];
  for (const [order, s] of stepSeeds.entries()) {
    const [row] = await db
      .insert(reachCampaignSteps)
      .values({
        id: generateId('rstp'),
        campaignId: (campaign as ReachCampaign).id,
        order,
        subject: s.subject,
        body: s.body,
        delayDays: s.delayDays ?? 3,
        delayHours: s.delayHours ?? 0,
        replyInThread: s.replyInThread ?? true,
      })
      .returning();
    steps.push(row as ReachCampaignStep);
  }
  for (const mailboxId of options.mailboxIds ?? []) {
    await db.insert(reachCampaignMailboxes).values({ id: generateId('rcmb'), campaignId: (campaign as ReachCampaign).id, mailboxId });
  }
  return { campaign: campaign as ReachCampaign, steps };
}

export async function seedEnrollment(
  db: Database,
  campaignId: string,
  prospectId: string,
  overrides: Partial<NewReachEnrollment> = {},
): Promise<ReachEnrollment> {
  const [row] = await db
    .insert(reachEnrollments)
    .values({
      id: generateId('renr'),
      campaignId,
      prospectId,
      status: 'active',
      nextSendAt: new Date('2026-10-12T08:00:00Z'),
      ...overrides,
    })
    .returning();
  return row as ReachEnrollment;
}

let messageCounter = 0;

/** An outbound message row as the send engine leaves it. */
export async function seedOutbound(
  db: Database,
  mailboxId: string,
  overrides: Partial<typeof reachMessages.$inferInsert> = {},
): Promise<typeof reachMessages.$inferSelect> {
  messageCounter += 1;
  const [row] = await db
    .insert(reachMessages)
    .values({
      id: generateId('rmsg'),
      direction: 'out',
      mailboxId,
      messageIdHeader: `seed${messageCounter}.${randomToken(6)}@getacme.com`,
      fromEmail: 'sam@getacme.com',
      toEmail: 'jane@bigco.io',
      subject: 'Seeded',
      status: 'sent',
      sentAt: new Date('2026-10-12T08:00:00Z'),
      ...overrides,
    })
    .returning();
  return row as typeof reachMessages.$inferSelect;
}
