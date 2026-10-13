/**
 * Shared helpers for the inbound mail and reply inbox tests: a fake R2 bucket,
 * a forwardable message built from a fixture, table resets and row seeds.
 * Not a test file itself (vitest only collects `*.test.ts`).
 */

import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  reachCampaigns,
  reachDomains,
  reachEnrollments,
  reachMailboxes,
  reachMessages,
  reachProspects,
  reachSettings,
  reachSuppressions,
  type ReachCampaign,
  type ReachEnrollment,
  type ReachMailbox,
  type ReachMessage,
  type ReachProspect,
} from '@weldsuite/db/schema';

/** The slice of R2 the handler and inbox use. */
export class FakeR2Bucket {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: Uint8Array | ArrayBuffer | string): Promise<void> {
    this.objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value));
  }

  async get(key: string): Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null> {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { arrayBuffer: async () => bytes.slice().buffer };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  asBucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

export interface ForwardableOptions {
  to: string;
  from?: string;
  /** Declared size; defaults to the real size. */
  rawSize?: number;
}

/** A Cloudflare Email Routing message wrapping `raw`. */
export function forwardable(raw: Uint8Array, options: ForwardableOptions): ForwardableEmailMessage {
  return {
    from: options.from ?? 'someone@example.net',
    to: options.to,
    headers: new Headers(),
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        // Two chunks, so the capped reader's accumulation is exercised.
        const mid = Math.floor(raw.byteLength / 2);
        controller.enqueue(raw.slice(0, mid));
        controller.enqueue(raw.slice(mid));
        controller.close();
      },
    }),
    rawSize: options.rawSize ?? raw.byteLength,
    setReject: () => undefined,
    forward: async () => undefined,
    reply: async () => undefined,
  } as unknown as ForwardableEmailMessage;
}

export function executionContext(): ExecutionContext & { pending: Promise<unknown>[]; settled(): Promise<void> } {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: () => undefined,
    props: {},
    settled: async () => {
      await Promise.allSettled(pending);
    },
  } as unknown as ExecutionContext & { pending: Promise<unknown>[]; settled(): Promise<void> };
}

/** Empty every table the reach tests touch. */
export async function resetTables(db: Database): Promise<void> {
  for (const table of [
    reachMessages,
    reachEnrollments,
    reachProspects,
    reachCampaigns,
    reachMailboxes,
    reachDomains,
    reachSuppressions,
    reachSettings,
    schema.crmActivities,
    schema.crmOpportunities,
    schema.crmPipelineStages,
    schema.personCompanies,
    schema.people,
    schema.companies,
    schema.workspaceMembers,
  ]) {
    await db.delete(table);
  }
}

export async function seedMailbox(db: Database, overrides: Partial<typeof reachMailboxes.$inferInsert> = {}): Promise<ReachMailbox> {
  const [row] = await db
    .insert(reachMailboxes)
    .values({
      id: generateId('rmbx'),
      domainId: 'rdom_test',
      email: 'sam@getacme.com',
      firstName: 'Sam',
      lastName: 'Jansen',
      type: 'shared',
      status: 'active',
      inboundToken: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      ...overrides,
    })
    .returning();
  return row!;
}

export async function seedProspect(db: Database, overrides: Partial<typeof reachProspects.$inferInsert> & { email: string }): Promise<ReachProspect> {
  const domain = overrides.email.split('@')[1] ?? null;
  const [row] = await db
    .insert(reachProspects)
    .values({ id: generateId('rpro'), companyDomain: domain, ...overrides })
    .returning();
  return row!;
}

export async function seedCampaign(db: Database, overrides: Partial<typeof reachCampaigns.$inferInsert> = {}): Promise<ReachCampaign> {
  const [row] = await db
    .insert(reachCampaigns)
    .values({ id: generateId('rcmp'), name: 'Logistics Q4', status: 'active', ...overrides })
    .returning();
  return row!;
}

export async function seedEnrollment(
  db: Database,
  overrides: Partial<typeof reachEnrollments.$inferInsert> & { campaignId: string; prospectId: string },
): Promise<ReachEnrollment> {
  const [row] = await db
    .insert(reachEnrollments)
    .values({ id: generateId('renr'), status: 'active', currentStep: 1, nextSendAt: new Date('2026-10-20T08:00:00Z'), ...overrides })
    .returning();
  return row!;
}

/** An outbound message we sent (what a reply or bounce is matched against). */
export async function seedOutbound(
  db: Database,
  overrides: Partial<typeof reachMessages.$inferInsert> & { messageIdHeader: string; mailboxId: string },
): Promise<ReachMessage> {
  const [row] = await db
    .insert(reachMessages)
    .values({
      id: generateId('rmsg'),
      direction: 'out',
      threadKey: overrides.messageIdHeader,
      fromEmail: 'sam@getacme.com',
      toEmail: 'prospect@example.com',
      subject: 'Quick question about Acme logistics',
      bodyText: 'Hi, quick question.',
      status: 'sent',
      sentAt: new Date('2026-10-12T07:14:00Z'),
      ...overrides,
    })
    .returning();
  return row!;
}

/** An inbound message row, for inbox tests that do not go through the pipeline. */
export async function seedInbound(
  db: Database,
  overrides: Partial<typeof reachMessages.$inferInsert> & { messageIdHeader: string; mailboxId: string; threadKey: string },
): Promise<ReachMessage> {
  const [row] = await db
    .insert(reachMessages)
    .values({
      id: generateId('rmsg'),
      direction: 'in',
      fromEmail: 'jane@acme.nl',
      toEmail: 'sam@getacme.com',
      subject: 'Re: Quick question about Acme logistics',
      snippet: 'Sounds interesting',
      kind: 'reply',
      receivedAt: new Date('2026-10-12T14:40:00Z'),
      ...overrides,
    })
    .returning();
  return row!;
}
