/**
 * The `email()` pipeline end to end against pglite and `.eml` fixtures:
 * token routing, parsing, matching, storage, stop-on-reply, suppression,
 * bounces, auto-replies, the CRM hand-off, events and the AI classification.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import {
  reachCampaigns,
  reachEnrollments,
  reachMessages,
  reachProspects,
  reachSettings,
  reachSuppressions,
  type ReachCampaign,
  type ReachMailbox,
  type ReachProspect,
} from '@weldsuite/db/schema';
import type { Env } from '../types';
import { loadFixture } from './__fixtures__/load';
import {
  FakeR2Bucket,
  executionContext,
  forwardable,
  resetTables,
  seedCampaign,
  seedEnrollment,
  seedMailbox,
  seedOutbound,
  seedProspect,
} from './test-support';
import { MAX_INBOUND_BYTES, processInboundEmail, readCapped, type InboundHandlerDeps } from './handler';
import { deliverInbound, type DeliverInboundInput } from '../services/inbound';
import type { ClassifyReplyFn } from '../services/classify';
import type { SinkEvent } from '../services/realtime';

vi.mock('../services/guardrails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/guardrails')>();
  return { ...actual, recordHardBounce: vi.fn(actual.recordHardBounce) };
});
import { recordHardBounce } from '../services/guardrails';
const hardBounce = vi.mocked(recordHardBounce);

const TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const ADDRESS = `reply+${TOKEN}@reply-test.weldreach.com`;
const ORG = 'org_reach_test';
const NOW = new Date('2026-10-12T14:41:00Z');

let db: Database;
let bucket: FakeR2Bucket;
let events: SinkEvent[];
let classifyCalls: Array<{ subject: string; text: string }>;
let classifyResult: Awaited<ReturnType<ClassifyReplyFn>>;
let mailbox: ReachMailbox;
let campaign: ReachCampaign;

function env(): Env {
  return {
    ENVIRONMENT: 'test',
    REACH_INBOUND_DOMAIN: 'reply-test.weldreach.com',
    STORAGE: bucket.asBucket(),
  } as unknown as Env;
}

function deps(overrides: Partial<InboundHandlerDeps> = {}): InboundHandlerDeps {
  return {
    resolveRoute: async (_env, token) => (token === TOKEN ? { clerkOrgId: ORG, mailboxId: mailbox.id } : null),
    openDb: async () => db,
    deliver: (input: DeliverInboundInput) =>
      deliverInbound({
        ...input,
        now: () => NOW,
        sink: async (event) => {
          events.push(event);
        },
        classify: async (_env, classifyInput) => {
          classifyCalls.push(classifyInput);
          return classifyResult;
        },
      }),
    ...overrides,
  };
}

async function receive(fixture: string, to = ADDRESS, handlerDeps = deps()) {
  const ctx = executionContext();
  const result = await processInboundEmail(forwardable(loadFixture(fixture), { to }), env(), ctx, handlerDeps);
  await ctx.settled();
  return result;
}

async function inboundRows() {
  return db.select().from(reachMessages).where(eq(reachMessages.direction, 'in'));
}

async function enrollmentStatus(id: string) {
  const [row] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.id, id)).limit(1);
  return row!;
}

async function campaignStats(id: string) {
  const [row] = await db.select({ stats: reachCampaigns.stats }).from(reachCampaigns).where(eq(reachCampaigns.id, id)).limit(1);
  return row!.stats;
}

async function suppression(value: string) {
  const [row] = await db.select().from(reachSuppressions).where(eq(reachSuppressions.value, value)).limit(1);
  return row ?? null;
}

/** A prospect with an active enrollment whose first email (`messageId`) is stored as sent. */
async function seedSent(email: string, messageId: string, extra: { firstName?: string; lastName?: string; companyName?: string } = {}) {
  const prospect = await seedProspect(db, { email, ...extra });
  const enrollment = await seedEnrollment(db, {
    campaignId: campaign.id,
    prospectId: prospect.id,
    mailboxId: mailbox.id,
    threadRootMessageId: messageId,
  });
  await seedOutbound(db, {
    messageIdHeader: messageId,
    mailboxId: mailbox.id,
    campaignId: campaign.id,
    enrollmentId: enrollment.id,
    prospectId: prospect.id,
    toEmail: email,
  });
  return { prospect, enrollment };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await resetTables(db);
  bucket = new FakeR2Bucket();
  events = [];
  classifyCalls = [];
  classifyResult = { ok: true, label: 'interested', modelId: 'test-model' };
  hardBounce.mockClear();
  mailbox = await seedMailbox(db);
  campaign = await seedCampaign(db);
});

describe('routing', () => {
  it('drops mail for an unknown token without touching a database', async () => {
    const openDb = vi.fn(async () => db);
    const result = await receive('gmail-reply.eml', 'reply+ffffffffffffffffffffffffffffffff@reply-test.weldreach.com', deps({ openDb }));
    expect(result).toBeNull();
    expect(openDb).not.toHaveBeenCalled();
    expect(await inboundRows()).toHaveLength(0);
  });

  it('drops mail that is not addressed to the inbound domain', async () => {
    const result = await receive('gmail-reply.eml', `${TOKEN}@example.com`);
    expect(result).toBeNull();
    expect(await inboundRows()).toHaveLength(0);
  });

  it('drops a message declared larger than the size cap', async () => {
    const ctx = executionContext();
    const message = forwardable(loadFixture('gmail-reply.eml'), { to: ADDRESS, rawSize: MAX_INBOUND_BYTES + 1 });
    expect(await processInboundEmail(message, env(), ctx, deps())).toBeNull();
    expect(await inboundRows()).toHaveLength(0);
  });

  it('stops reading a stream that grows past the cap', async () => {
    const chunk = new Uint8Array(1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
        if (sent > 100) controller.close();
      },
    });
    expect(await readCapped(stream, 10 * 1024)).toBeNull();
    expect(sent).toBeLessThan(40);
  });

  it('drops mail whose mailbox no longer exists', async () => {
    await db.update(schema.reachMailboxes).set({ deletedAt: new Date() }).where(eq(schema.reachMailboxes.id, mailbox.id));
    expect(await receive('gmail-reply.eml')).toBeNull();
    expect(await inboundRows()).toHaveLength(0);
  });

  it('never throws on a processing failure; the raw message is parked in R2 for replay', async () => {
    const failing = deps({ deliver: async () => { throw new Error('database unavailable'); } });
    expect(await receive('gmail-reply.eml', ADDRESS, failing)).toBeNull();
    const parked = [...bucket.objects.keys()].filter((k) => k.startsWith(`reach/${ORG}/_failed/`));
    expect(parked).toHaveLength(1);
  });
});

describe('a Gmail reply (threading headers)', () => {
  it('stores the reply in the thread of the message it answers', async () => {
    const { prospect, enrollment } = await seedSent('jane@acme.nl', 'out-1001@getacme.com', { firstName: 'Jane', lastName: 'Doe', companyName: 'Acme BV' });
    const result = await receive('gmail-reply.eml');
    expect(result).toMatchObject({ status: 'stored', kind: 'reply', matched: true, threadKey: 'out-1001@getacme.com' });

    const [row] = await inboundRows();
    expect(row).toMatchObject({
      direction: 'in',
      kind: 'reply',
      mailboxId: mailbox.id,
      threadKey: 'out-1001@getacme.com',
      campaignId: campaign.id,
      enrollmentId: enrollment.id,
      prospectId: prospect.id,
      messageIdHeader: 'CAKx9Qm7vJ1-gmail-reply-1@mail.gmail.com',
      inReplyTo: 'out-1001@getacme.com',
      fromEmail: 'jane@acme.nl',
      toEmail: 'sam@getacme.com',
      subject: 'Re: Quick question about Acme logistics',
      handledAt: null,
      readAt: null,
    });
    expect(row!.snippet).toBe('Hi Sam, This looks interesting. Can you send me a few more details and pricing? Thanks, Jane');
    expect(row!.receivedAt).toEqual(NOW);
  });

  it('keeps the raw message in R2 under reach/<org>/<message id>.eml', async () => {
    await seedSent('jane@acme.nl', 'out-1001@getacme.com');
    await receive('gmail-reply.eml');
    const [row] = await inboundRows();
    expect(row!.r2Key).toBe(`reach/${ORG}/${row!.id}.eml`);
    expect(bucket.objects.get(row!.r2Key!)).toBeDefined();
  });

  it('stops the sequence, counts the reply and announces it', async () => {
    const { enrollment } = await seedSent('jane@acme.nl', 'out-1001@getacme.com');
    await receive('gmail-reply.eml');

    const after = await enrollmentStatus(enrollment.id);
    expect(after).toMatchObject({ status: 'replied', stoppedReason: 'replied', nextSendAt: null, claimedAt: null });
    expect((await campaignStats(campaign.id)).replied).toBe(1);

    const received = events.find((e) => e.entityType === 'reach_reply' && e.action === 'received');
    expect(received?.data).toMatchObject({ kind: 'reply', fromEmail: 'jane@acme.nl', campaignId: campaign.id });
    // The message text never rides the event bus.
    expect(JSON.stringify(received?.data)).not.toContain('pricing');
  });

  it('hands the prospect to the CRM: person, company, activity and the prospect link', async () => {
    const { prospect } = await seedSent('jane@acme.nl', 'out-1001@getacme.com', { firstName: 'Jane', lastName: 'Doe', companyName: 'Acme BV' });
    await receive('gmail-reply.eml');

    const [person] = await db.select().from(schema.people).where(eq(schema.people.email, 'jane@acme.nl'));
    expect(person).toMatchObject({ firstName: 'Jane', lastName: 'Doe', inCrm: true });
    const [company] = await db.select().from(schema.companies);
    expect(company).toMatchObject({ name: 'Acme BV', website: 'https://acme.nl' });
    const links = await db.select().from(schema.personCompanies);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ personId: person!.id, companyId: company!.id });

    const [activity] = await db.select().from(schema.crmActivities);
    expect(activity).toMatchObject({
      type: 'email',
      subject: 'Replied to outreach campaign Logistics Q4',
      personId: person!.id,
      customerId: company!.id,
      emailFrom: 'jane@acme.nl',
    });

    const [linked] = await db.select().from(reachProspects).where(eq(reachProspects.id, prospect.id));
    expect(linked!.personId).toBe(person!.id);
    expect(events.map((e) => `${e.entityType}:${e.action}`)).toEqual(
      expect.arrayContaining(['person:created', 'company:created', 'activity:created']),
    );
  });

  it('links an existing CRM company by website and an existing person by email', async () => {
    await seedSent('jane@acme.nl', 'out-1001@getacme.com', { firstName: 'Jane', companyName: 'Something Else' });
    await db.insert(schema.companies).values({ id: 'cmp_existing', name: 'Acme Logistics', displayName: 'Acme Logistics', website: 'https://www.acme.nl/about' });
    await db.insert(schema.people).values({ id: 'per_existing', email: 'JANE@acme.nl', firstName: 'Jane', displayName: 'Jane', inCrm: false });

    await receive('gmail-reply.eml');

    expect(await db.select().from(schema.companies)).toHaveLength(1);
    expect(await db.select().from(schema.people)).toHaveLength(1);
    const [person] = await db.select().from(schema.people);
    expect(person!.inCrm).toBe(true);
    const [activity] = await db.select().from(schema.crmActivities);
    expect(activity).toMatchObject({ personId: 'per_existing', customerId: 'cmp_existing' });
  });

  it('assigns the CRM records to the campaign owner when they are still a workspace member', async () => {
    await db.insert(schema.workspaceMembers).values({ id: 'wm_owner', userId: 'user_owner', role: 'MEMBER' });
    await db.update(reachCampaigns).set({ ownerId: 'user_owner' }).where(eq(reachCampaigns.id, campaign.id));
    await seedSent('jane@acme.nl', 'out-1001@getacme.com', { firstName: 'Jane', companyName: 'Acme BV' });
    await receive('gmail-reply.eml');

    const [person] = await db.select().from(schema.people).where(eq(schema.people.email, 'jane@acme.nl'));
    const [company] = await db.select().from(schema.companies);
    const [activity] = await db.select().from(schema.crmActivities);
    expect(person!.ownerId).toBe('user_owner');
    expect(company!.ownerId).toBe('user_owner');
    expect(activity!.assignedToId).toBe('user_owner');
  });

  it('falls back to a system assignee when the campaign owner has left the workspace', async () => {
    await db.update(reachCampaigns).set({ ownerId: 'user_gone' }).where(eq(reachCampaigns.id, campaign.id));
    await seedSent('jane@acme.nl', 'out-1001@getacme.com');
    await receive('gmail-reply.eml');
    const [person] = await db.select().from(schema.people).where(eq(schema.people.email, 'jane@acme.nl'));
    const [activity] = await db.select().from(schema.crmActivities);
    expect(person!.ownerId).toBeNull();
    expect(activity!.assignedToId).toBe('system');
  });

  it('classifies the reply in the background and acts on the label', async () => {
    await seedSent('jane@acme.nl', 'out-1001@getacme.com');
    await receive('gmail-reply.eml');

    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]!.subject).toBe('Re: Quick question about Acme logistics');
    expect(classifyCalls[0]!.text).toContain('a few more details and pricing');
    expect(classifyCalls[0]!.text).not.toContain('warehouse network');

    const [row] = await inboundRows();
    expect(row).toMatchObject({ label: 'interested', labelSource: 'ai' });
    expect(row!.classifiedAt).not.toBeNull();
    expect((await campaignStats(campaign.id)).interested).toBe(1);
    const classified = events.find((e) => e.action === 'classified');
    expect(classified?.data).toMatchObject({ label: 'interested', labelSource: 'ai' });
  });

  it('keeps the reply as unclassified when the model is unavailable, and still stops the sequence', async () => {
    classifyResult = { ok: false, reason: 'ai_error' };
    const { enrollment } = await seedSent('jane@acme.nl', 'out-1001@getacme.com');
    await receive('gmail-reply.eml');

    const [row] = await inboundRows();
    expect(row).toMatchObject({ label: 'unclassified', labelSource: null, classifiedAt: null });
    expect((await enrollmentStatus(enrollment.id)).status).toBe('replied');
    expect(events.some((e) => e.action === 'classified')).toBe(false);
  });

  it('an AI "unsubscribe" suppresses the sender and ends the sequence as unsubscribed', async () => {
    classifyResult = { ok: true, label: 'unsubscribe', modelId: 'test-model' };
    const { enrollment } = await seedSent('jane@acme.nl', 'out-1001@getacme.com');
    await receive('gmail-reply.eml');

    expect((await suppression('jane@acme.nl'))?.reason).toBe('unsubscribed');
    expect((await enrollmentStatus(enrollment.id)).status).toBe('unsubscribed');
    const stats = await campaignStats(campaign.id);
    expect(stats).toMatchObject({ replied: 1, unsubscribed: 1 });
  });
});

describe('a duplicate delivery', () => {
  it('is stored once and counted once', async () => {
    const { enrollment } = await seedSent('jane@acme.nl', 'out-1001@getacme.com');
    const first = await receive('gmail-reply.eml');
    const second = await receive('gmail-reply.eml');
    expect(first).toMatchObject({ status: 'stored' });
    expect(second).toMatchObject({ status: 'duplicate' });
    expect(await inboundRows()).toHaveLength(1);
    expect((await campaignStats(campaign.id)).replied).toBe(1);
    expect((await enrollmentStatus(enrollment.id)).status).toBe('replied');
    expect(classifyCalls).toHaveLength(1);
    expect(bucket.objects.size).toBe(1);
  });
});

describe('an Outlook reply and the stop scope', () => {
  async function seedAcmeTeam() {
    const jane = await seedSent('jane@acme.nl', 'out-1001@getacme.com');
    const pieter = await seedSent('pieter@acme.nl', 'out-2001@getacme.com');
    return { jane, pieter };
  }

  it('decodes the windows-1252 reply and cuts the Outlook history from the snippet', async () => {
    await seedAcmeTeam();
    await receive('outlook-reply.eml');
    const [row] = await inboundRows();
    expect(row!.snippet).toContain('please don’t contact me again');
    expect(row!.snippet).not.toContain('Sent: Monday');
    expect(row!.threadKey).toBe('out-2001@getacme.com');
  });

  it('with prospect scope only the replying prospect stops', async () => {
    const { jane, pieter } = await seedAcmeTeam();
    await receive('outlook-reply.eml');
    expect((await enrollmentStatus(pieter.enrollment.id)).status).toBe('replied');
    expect((await enrollmentStatus(jane.enrollment.id)).status).toBe('active');
  });

  it('with company scope everyone at the same company domain stops', async () => {
    await db.insert(reachSettings).values({ id: 'rset_test', stopOnReplyScope: 'company' });
    const { jane, pieter } = await seedAcmeTeam();
    await receive('outlook-reply.eml');
    expect((await enrollmentStatus(pieter.enrollment.id)).status).toBe('replied');
    const janeAfter = await enrollmentStatus(jane.enrollment.id);
    expect(janeAfter).toMatchObject({ status: 'replied', stoppedReason: 'replied_company', nextSendAt: null });
    // The campaign counts one reply, not one per stopped enrollment.
    expect((await campaignStats(campaign.id)).replied).toBe(1);
  });

  it('company scope never fans out over a free-mail domain', async () => {
    await db.insert(reachSettings).values({ id: 'rset_test', stopOnReplyScope: 'company' });
    const { pieter } = await seedAcmeTeam();
    await db.update(reachProspects).set({ email: 'pieter@gmail.com', companyDomain: 'gmail.com' }).where(eq(reachProspects.id, pieter.prospect.id));
    const other = await seedProspect(db, { email: 'someone@gmail.com' });
    const otherEnrollment = await seedEnrollment(db, { campaignId: campaign.id, prospectId: other.id, mailboxId: mailbox.id });

    await receive('outlook-reply.eml');
    expect((await enrollmentStatus(pieter.enrollment.id)).status).toBe('replied');
    expect((await enrollmentStatus(otherEnrollment.id)).status).toBe('active');
  });

  it('also stops the same prospect in other campaigns', async () => {
    const { pieter } = await seedAcmeTeam();
    const second = await seedCampaign(db, { name: 'Second' });
    const secondEnrollment = await seedEnrollment(db, { campaignId: second.id, prospectId: pieter.prospect.id, mailboxId: mailbox.id });
    await receive('outlook-reply.eml');
    expect(await enrollmentStatus(secondEnrollment.id)).toMatchObject({ status: 'replied', stoppedReason: 'replied_elsewhere' });
  });
});

describe('a reply without threading headers', () => {
  it('is matched by sender to the prospect enrolled on this mailbox', async () => {
    const lisa = await seedProspect(db, { email: 'lisa@bluesky.io', firstName: 'Lisa' });
    const enrollment = await seedEnrollment(db, {
      campaignId: campaign.id,
      prospectId: lisa.id,
      mailboxId: mailbox.id,
      threadRootMessageId: 'out-4001@getacme.com',
    });
    const result = await receive('reply-no-threading.eml');
    expect(result).toMatchObject({ status: 'stored', matched: true, threadKey: 'out-4001@getacme.com' });

    const [row] = await inboundRows();
    expect(row).toMatchObject({ prospectId: lisa.id, enrollmentId: enrollment.id, campaignId: campaign.id, inReplyTo: null });
    expect((await enrollmentStatus(enrollment.id)).status).toBe('replied');
    expect(classifyCalls).toHaveLength(1);
  });

  it('picks the most recent enrollment on this mailbox, not one on another mailbox', async () => {
    const other = await seedMailbox(db, { email: 'other@getacme.com', inboundToken: 'ffffffffffffffffffffffffffffffff' });
    const lisa = await seedProspect(db, { email: 'lisa@bluesky.io' });
    const elsewhere = await seedCampaign(db, { name: 'On the other mailbox' });
    await seedEnrollment(db, { campaignId: elsewhere.id, prospectId: lisa.id, mailboxId: other.id, threadRootMessageId: 'out-other@getacme.com' });
    const mine = await seedEnrollment(db, { campaignId: campaign.id, prospectId: lisa.id, mailboxId: mailbox.id, threadRootMessageId: 'out-mine@getacme.com' });
    await receive('reply-no-threading.eml');
    const [row] = await inboundRows();
    expect(row!.enrollmentId).toBe(mine.id);
  });

  it('a sender nobody knows is stored as an open reply with no prospect, no effects and no AI spend', async () => {
    const result = await receive('reply-no-threading.eml');
    expect(result).toMatchObject({ status: 'stored', kind: 'reply', matched: false });
    const [row] = await inboundRows();
    expect(row).toMatchObject({ prospectId: null, campaignId: null, enrollmentId: null, label: null, handledAt: null });
    expect(row!.threadKey).toBe(row!.messageIdHeader);
    expect(classifyCalls).toHaveLength(0);
    expect(await db.select().from(schema.people)).toHaveLength(0);
  });

  it('mailing-list mail that answers nothing is recorded as an auto-reply, not a reply', async () => {
    const raw = [
      'From: Newsletter <news@vendor.example>',
      'To: sam@getacme.com',
      'Subject: October offers',
      'Message-ID: <news-1@vendor.example>',
      'List-Unsubscribe: <https://vendor.example/unsub>',
      'Content-Type: text/plain',
      '',
      'Big savings.',
    ].join('\r\n');
    const ctx = executionContext();
    const result = await processInboundEmail(
      forwardable(new TextEncoder().encode(raw), { to: ADDRESS }),
      env(),
      ctx,
      deps(),
    );
    expect(result).toMatchObject({ status: 'stored', kind: 'auto_reply' });
    expect(classifyCalls).toHaveLength(0);
  });
});

describe('automatic replies', () => {
  it('an English out-of-office is recorded read and handled, and the sequence goes on', async () => {
    const { enrollment } = await seedSent('jane@acme.nl', 'out-1001@getacme.com');
    const result = await receive('ooo-en.eml');
    expect(result).toMatchObject({ status: 'stored', kind: 'auto_reply', matched: true });

    const [row] = await inboundRows();
    expect(row).toMatchObject({ kind: 'auto_reply', handledBy: 'system', threadKey: 'out-1001@getacme.com' });
    expect(row!.readAt).toEqual(NOW);
    expect(row!.handledAt).toEqual(NOW);
    expect(await enrollmentStatus(enrollment.id)).toMatchObject({ status: 'active', stoppedReason: null });
    expect((await campaignStats(campaign.id)).replied).toBe(0);
    expect(classifyCalls).toHaveLength(0);
    expect(await db.select().from(schema.people)).toHaveLength(0);
  });

  it('a Dutch out-of-office is recognised by its subject alone', async () => {
    const { enrollment } = await seedSent('tom@redwood.eu', 'out-1010@getacme.com');
    const result = await receive('ooo-nl.eml');
    expect(result).toMatchObject({ status: 'stored', kind: 'auto_reply' });
    expect((await enrollmentStatus(enrollment.id)).status).toBe('active');
  });

  it('stops the sequence when the campaign says to stop on auto-replies', async () => {
    await db.update(reachCampaigns).set({ stopOnAutoReply: true }).where(eq(reachCampaigns.id, campaign.id));
    const { enrollment } = await seedSent('jane@acme.nl', 'out-1001@getacme.com');
    await receive('ooo-en.eml');
    expect(await enrollmentStatus(enrollment.id)).toMatchObject({ status: 'replied', stoppedReason: 'auto_reply' });
    expect((await campaignStats(campaign.id)).replied).toBe(0);
  });
});

describe('opt-out replies', () => {
  it('"Unsubscribe" is honoured by rule: suppressed, labelled, no CRM person, no AI call', async () => {
    const { enrollment } = await seedSent('tom@redwood.eu', 'out-1010@getacme.com');
    await receive('unsubscribe-reply.eml');

    expect(await suppression('tom@redwood.eu')).toMatchObject({ reason: 'unsubscribed', type: 'email' });
    const [row] = await inboundRows();
    expect(row).toMatchObject({ label: 'unsubscribe', labelSource: 'rule', kind: 'reply' });
    expect(await enrollmentStatus(enrollment.id)).toMatchObject({ status: 'unsubscribed', stoppedReason: 'unsubscribed' });
    expect(await campaignStats(campaign.id)).toMatchObject({ unsubscribed: 1, replied: 0 });
    const [prospect] = await db.select().from(reachProspects).where(eq(reachProspects.email, 'tom@redwood.eu'));
    expect(prospect!.validation).toBe('suppressed');
    expect(classifyCalls).toHaveLength(0);
    expect(await db.select().from(schema.people)).toHaveLength(0);
    expect(events.find((e) => e.action === 'classified')?.data).toMatchObject({ label: 'unsubscribe', labelSource: 'rule' });
  });

  it('suppresses an unknown sender who asks to be removed', async () => {
    const raw = ['From: Anon <anon@somewhere.example>', 'To: sam@getacme.com', 'Subject: unsubscribe', 'Message-ID: <anon-1@somewhere.example>', '', ''].join('\r\n');
    const result = await processInboundEmail(forwardable(new TextEncoder().encode(raw), { to: ADDRESS }), env(), executionContext(), deps());
    expect(result).toMatchObject({ status: 'stored', matched: false, label: 'unsubscribe' });
    expect((await suppression('anon@somewhere.example'))?.reason).toBe('unsubscribed');
  });
});

describe('bounces', () => {
  async function expectBounced(fixture: string, messageId: string, recipient: string) {
    const { enrollment } = await seedSent(recipient, messageId);
    const result = await receive(fixture);
    expect(result).toMatchObject({ status: 'stored', kind: 'bounce', matched: true });

    expect(await enrollmentStatus(enrollment.id)).toMatchObject({ status: 'bounced', nextSendAt: null });
    expect(await suppression(recipient)).toMatchObject({ reason: 'bounced', type: 'email' });
    expect((await campaignStats(campaign.id)).bounced).toBe(1);
    expect(hardBounce).toHaveBeenCalledTimes(1);
    expect(hardBounce.mock.calls[0]![1]).toEqual({ mailboxId: mailbox.id, campaignId: campaign.id });

    const [row] = await inboundRows();
    expect(row).toMatchObject({ kind: 'bounce', handledBy: 'system', enrollmentId: enrollment.id, threadKey: messageId });
    expect(row!.snippet).toContain(recipient);
    expect(classifyCalls).toHaveLength(0);
    expect(await db.select().from(schema.people)).toHaveLength(0);
  }

  it('Gmail DSN', async () => {
    await expectBounced('bounce-gmail-dsn.eml', 'out-3001@getacme.com', 'nobody@acme.nl');
  });

  it('Outlook / Exchange NDR', async () => {
    await expectBounced('bounce-outlook-ndr.eml', 'out-3002@getacme.com', 'former.employee@bluesky.io');
  });

  it('Postfix DSN with headers only', async () => {
    await expectBounced('bounce-postfix-dsn.eml', 'out-3003@getacme.com', 'gone@oldco.example');
  });

  it('plain-text "Mail Delivery Subsystem" notice', async () => {
    await expectBounced('bounce-nondsn.eml', 'out-3004@getacme.com', 'missing.person@example.org');
  });

  it('a bounce is matched by the failed recipient when the original Message-ID is not in the notice', async () => {
    const { enrollment } = await seedSent('nobody@acme.nl', 'out-different@getacme.com');
    await receive('bounce-gmail-dsn.eml');
    // The DSN names out-3001, which is not stored: the failed recipient finds the prospect instead.
    expect((await enrollmentStatus(enrollment.id)).status).toBe('bounced');
  });

  it('a delay notice records the message and changes nothing else', async () => {
    const { enrollment } = await seedSent('slow@example.org', 'out-3005@getacme.com');
    const result = await receive('bounce-delayed.eml');
    expect(result).toMatchObject({ status: 'stored', kind: 'bounce' });
    expect((await enrollmentStatus(enrollment.id)).status).toBe('active');
    expect(await suppression('slow@example.org')).toBeNull();
    expect(hardBounce).not.toHaveBeenCalled();
    expect((await campaignStats(campaign.id)).bounced).toBe(0);
  });

  it('a bounce delivered twice is counted once', async () => {
    await seedSent('nobody@acme.nl', 'out-3001@getacme.com');
    await receive('bounce-gmail-dsn.eml');
    await receive('bounce-gmail-dsn.eml');
    expect((await campaignStats(campaign.id)).bounced).toBe(1);
    expect(hardBounce).toHaveBeenCalledTimes(1);
  });

  it('five hard bounces pause the mailbox through the guardrail', async () => {
    const bounced = await Promise.all(
      [1, 2, 3, 4].map(async (n) => {
        const prospect = await seedProspect(db, { email: `gone${n}@oldco.example` });
        return seedEnrollment(db, { campaignId: campaign.id, prospectId: prospect.id, mailboxId: mailbox.id, status: 'bounced' });
      }),
    );
    expect(bounced).toHaveLength(4);
    await seedSent('nobody@acme.nl', 'out-3001@getacme.com');
    await receive('bounce-gmail-dsn.eml');
    const [after] = await db.select().from(schema.reachMailboxes).where(eq(schema.reachMailboxes.id, mailbox.id));
    expect(after).toMatchObject({ status: 'paused', pausedReason: 'bounces' });
  });
});

describe('our own mailboxes', () => {
  it('mail from one of the workspace mailboxes is ignored', async () => {
    await seedMailbox(db, { email: 'jane@acme.nl', inboundToken: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' });
    const result = await receive('gmail-reply.eml');
    expect(result).toEqual({ status: 'ignored', reason: 'own_mailbox' });
    expect(await inboundRows()).toHaveLength(0);
  });
});

describe('failures during effects', () => {
  it('rolls the stored message back so a replay is not de-duplicated away', async () => {
    await seedSent('jane@acme.nl', 'out-1001@getacme.com');
    // Break a write that only happens after the message row is stored (the stop-scope lookup).
    await db.execute(sql.raw('alter table reach_settings rename to reach_settings_broken'));
    try {
      await expect(
        deliverInbound({
          env: env(),
          db,
          clerkOrgId: ORG,
          mailbox,
          raw: loadFixture('gmail-reply.eml'),
          waitUntil: () => undefined,
          now: () => NOW,
          sink: () => undefined,
          classify: async () => ({ ok: false, reason: 'ai_error' }),
        }),
      ).rejects.toThrow();
    } finally {
      await db.execute(sql.raw('alter table reach_settings_broken rename to reach_settings'));
    }
    expect(await inboundRows()).toHaveLength(0);

    // Replayed once the database is healthy again.
    const replay = await receive('gmail-reply.eml');
    expect(replay).toMatchObject({ status: 'stored' });
    expect(await inboundRows()).toHaveLength(1);
    // The enrollment had already been stopped by the failed attempt: the replay does not count it twice.
    expect((await campaignStats(campaign.id)).replied).toBe(1);
  });
});

describe('prospects of other campaigns', () => {
  it('a reply never touches an enrollment that already ended', async () => {
    const { enrollment } = await seedSent('jane@acme.nl', 'out-1001@getacme.com');
    await db.update(reachEnrollments).set({ status: 'bounced' }).where(eq(reachEnrollments.id, enrollment.id));
    await receive('gmail-reply.eml');
    expect((await enrollmentStatus(enrollment.id)).status).toBe('bounced');
    expect((await campaignStats(campaign.id)).replied).toBe(0);
  });
});

