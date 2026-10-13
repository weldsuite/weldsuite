/**
 * Reply classification: the metered model call and its fallbacks (it must
 * never fail reply processing), and what a stored classification does.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { reachCampaigns, reachEnrollments, reachMessages, reachSuppressions, type ReachMessage } from '@weldsuite/db/schema';
import type { Env } from '../types';
import { resetTables, seedCampaign, seedEnrollment, seedInbound, seedMailbox, seedProspect } from '../email/test-support';
import type { SinkEvent } from './realtime';

const ai = vi.hoisted(() => ({
  assertGatewayConfigured: vi.fn(),
  createWeldAI: vi.fn(() => ({ model: (id: string) => ({ id }) })),
  generateObject: vi.fn(),
}));
vi.mock('@weldsuite/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/ai')>();
  return { ...actual, ...ai };
});

const billing = vi.hoisted(() => ({
  resolveAiMetering: vi.fn(async () => ({ metering: true })),
  assertAiCredits: vi.fn(async () => undefined),
  chargeAiUsage: vi.fn(async () => 1),
  InsufficientAiCreditsError: class InsufficientAiCreditsError extends Error {},
}));
vi.mock('@weldsuite/core-domain/ai-billing', () => billing);

import { CLASSIFY_MODEL_ID, classifyReplyText, classifyStoredReply, isClassifiableLabel } from './classify';

const env = { CF_ACCOUNT_ID: 'acct', DATABASE_URL_MASTER: 'postgres://master' } as unknown as Env;
const context = { clerkOrgId: 'org_test', referenceId: 'rmsg_1' };

beforeEach(() => {
  vi.clearAllMocks();
  ai.assertGatewayConfigured.mockImplementation(() => undefined);
  ai.generateObject.mockResolvedValue({ object: { label: 'interested' }, usage: { inputTokens: 120, outputTokens: 6 } });
  billing.assertAiCredits.mockResolvedValue(undefined);
  billing.resolveAiMetering.mockResolvedValue({ metering: true });
});

describe('classifyReplyText', () => {
  it('returns the model label and meters the call against the workspace wallet', async () => {
    const outcome = await classifyReplyText(env, { subject: 'Re: hi', text: 'Graag meer informatie over de prijzen.' }, context);
    expect(outcome).toEqual({ ok: true, label: 'interested', modelId: CLASSIFY_MODEL_ID });

    expect(billing.resolveAiMetering).toHaveBeenCalledWith(env, 'org_test', 'system');
    expect(billing.assertAiCredits).toHaveBeenCalledTimes(1);
    expect(billing.chargeAiUsage).toHaveBeenCalledWith(
      { metering: true },
      { modelId: CLASSIFY_MODEL_ID, usage: { inputTokens: 120, outputTokens: 6 }, op: 'reach_reply_classify', referenceId: 'rmsg_1' },
    );
    const call = ai.generateObject.mock.calls[0]![0] as { prompt: string; system: string };
    expect(call.prompt).toContain('Graag meer informatie');
    expect(call.system).toContain('Dutch, English or German');
  });

  it('is gated before the call: an empty wallet means no model call', async () => {
    billing.assertAiCredits.mockRejectedValue(new billing.InsufficientAiCreditsError('Insufficient credits'));
    expect(await classifyReplyText(env, { subject: 's', text: 'yes please' }, context)).toEqual({ ok: false, reason: 'insufficient_credits' });
    expect(ai.generateObject).not.toHaveBeenCalled();
    expect(billing.chargeAiUsage).not.toHaveBeenCalled();
  });

  it('reports an unconfigured gateway', async () => {
    ai.assertGatewayConfigured.mockImplementation(() => {
      throw new Error('no gateway');
    });
    expect(await classifyReplyText(env, { subject: 's', text: 'yes' }, context)).toEqual({ ok: false, reason: 'not_configured' });
    expect(ai.generateObject).not.toHaveBeenCalled();
  });

  it('turns any model error into an outcome instead of throwing', async () => {
    ai.generateObject.mockRejectedValue(new Error('gateway 502'));
    expect(await classifyReplyText(env, { subject: 's', text: 'yes' }, context)).toEqual({ ok: false, reason: 'ai_error' });
  });

  it('turns an unexpected billing failure into an outcome too', async () => {
    billing.assertAiCredits.mockRejectedValue(new Error('master db down'));
    expect(await classifyReplyText(env, { subject: 's', text: 'yes' }, context)).toEqual({ ok: false, reason: 'ai_error' });
  });

  it('rejects a label that is not in the set (JSON mode is best effort) but still charges the tokens', async () => {
    ai.generateObject.mockResolvedValue({ object: { label: 'very_interested' }, usage: { inputTokens: 10, outputTokens: 3 } });
    expect(await classifyReplyText(env, { subject: 's', text: 'yes' }, context)).toEqual({ ok: false, reason: 'ai_error' });
    expect(billing.chargeAiUsage).toHaveBeenCalledTimes(1);
  });

  it('spends nothing on an empty reply', async () => {
    expect(await classifyReplyText(env, { subject: 's', text: '   ' }, context)).toEqual({ ok: false, reason: 'empty' });
    expect(billing.assertAiCredits).not.toHaveBeenCalled();
  });

  it('only ever gives the model the head of a long reply', async () => {
    await classifyReplyText(env, { subject: 'x'.repeat(500), text: 'y'.repeat(10_000) }, context);
    const call = ai.generateObject.mock.calls[0]![0] as { prompt: string };
    expect(call.prompt.length).toBeLessThan(2400);
  });

  it('knows its labels', () => {
    expect(isClassifiableLabel('meeting_request')).toBe(true);
    expect(isClassifiableLabel('unclassified')).toBe(false);
    expect(isClassifiableLabel(undefined)).toBe(false);
  });
});

describe('classifyStoredReply', () => {
  let db: Database;
  let events: SinkEvent[];

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 120_000);

  async function seedReply(overrides: Partial<Omit<typeof reachMessages.$inferInsert, 'messageIdHeader' | 'threadKey' | 'mailboxId'>> = {}) {
    const mailbox = await seedMailbox(db);
    const campaign = await seedCampaign(db);
    const prospect = await seedProspect(db, { email: 'jane@acme.nl' });
    const enrollment = await seedEnrollment(db, { campaignId: campaign.id, prospectId: prospect.id, mailboxId: mailbox.id, status: 'replied' });
    const message = await seedInbound(db, {
      messageIdHeader: 'reply-1@mail.example',
      threadKey: 'out-1@getacme.com',
      mailboxId: mailbox.id,
      campaignId: campaign.id,
      enrollmentId: enrollment.id,
      prospectId: prospect.id,
      ...overrides,
    });
    return { mailbox, campaign, prospect, enrollment, message };
  }

  const deps = (classify: Parameters<typeof classifyStoredReply>[0]['classify']) => ({
    env,
    db,
    clerkOrgId: 'org_test',
    sink: (event: SinkEvent) => {
      events.push(event);
    },
    classify,
  });

  async function stored(id: string): Promise<ReachMessage> {
    const [row] = await db.select().from(reachMessages).where(eq(reachMessages.id, id));
    return row!;
  }

  beforeEach(async () => {
    await resetTables(db);
    events = [];
  });

  it('stores an AI label, counts interest and announces it', async () => {
    const { message, campaign } = await seedReply();
    const label = await classifyStoredReply(deps(async () => ({ ok: true, label: 'meeting_request', modelId: 'm' })), { ...message, text: 'Can we talk Tuesday?' });
    expect(label).toBe('meeting_request');
    expect(await stored(message.id)).toMatchObject({ label: 'meeting_request', labelSource: 'ai' });
    const [after] = await db.select({ stats: reachCampaigns.stats }).from(reachCampaigns).where(eq(reachCampaigns.id, campaign.id));
    expect(after!.stats.interested).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityType: 'reach_reply', action: 'classified', entityId: message.id });
    expect(events[0]!.data).toMatchObject({ label: 'meeting_request', labelSource: 'ai' });
  });

  it('falls back to unclassified when the AI fails, without an event or any side effect', async () => {
    const { message, enrollment } = await seedReply();
    const label = await classifyStoredReply(deps(async () => ({ ok: false, reason: 'ai_error' })), { ...message, text: 'hello' });
    expect(label).toBe('unclassified');
    expect(await stored(message.id)).toMatchObject({ label: 'unclassified', labelSource: null, classifiedAt: null });
    expect(events).toHaveLength(0);
    const [row] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.id, enrollment.id));
    expect(row!.status).toBe('replied');
  });

  it('falls back to unclassified when the wallet is empty', async () => {
    const { message } = await seedReply();
    const label = await classifyStoredReply(deps(async () => ({ ok: false, reason: 'insufficient_credits' })), { ...message, text: 'hello' });
    expect(label).toBe('unclassified');
  });

  it('survives a classifier that throws', async () => {
    const { message } = await seedReply();
    const label = await classifyStoredReply(
      deps(async () => {
        throw new Error('boom');
      }),
      { ...message, text: 'hello' },
    );
    expect(label).toBe('unclassified');
  });

  it('"unsubscribe" suppresses the sender and ends the sequence', async () => {
    const { message, enrollment, campaign } = await seedReply();
    await classifyStoredReply(deps(async () => ({ ok: true, label: 'unsubscribe', modelId: 'm' })), { ...message, text: 'Please remove me' });
    const [suppression] = await db.select().from(reachSuppressions).where(eq(reachSuppressions.value, 'jane@acme.nl'));
    expect(suppression).toMatchObject({ reason: 'unsubscribed', source: message.id });
    const [row] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.id, enrollment.id));
    expect(row).toMatchObject({ status: 'unsubscribed', stoppedReason: 'unsubscribed' });
    const [after] = await db.select({ stats: reachCampaigns.stats }).from(reachCampaigns).where(eq(reachCampaigns.id, campaign.id));
    expect(after!.stats.unsubscribed).toBe(1);
  });

  it('never overwrites a label a person chose while the model was running', async () => {
    const { message, campaign } = await seedReply();
    const label = await classifyStoredReply(
      deps(async () => {
        await db.update(reachMessages).set({ label: 'not_now', labelSource: 'user' }).where(eq(reachMessages.id, message.id));
        return { ok: true, label: 'interested', modelId: 'm' };
      }),
      { ...message, text: 'hello' },
    );
    expect(label).toBe('interested');
    expect(await stored(message.id)).toMatchObject({ label: 'not_now', labelSource: 'user' });
    const [after] = await db.select({ stats: reachCampaigns.stats }).from(reachCampaigns).where(eq(reachCampaigns.id, campaign.id));
    expect(after!.stats.interested).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('a later successful classification replaces an earlier unclassified', async () => {
    const { message } = await seedReply();
    await classifyStoredReply(deps(async () => ({ ok: false, reason: 'ai_error' })), { ...message, text: 'hello' });
    await classifyStoredReply(deps(async () => ({ ok: true, label: 'not_interested', modelId: 'm' })), { ...message, text: 'hello' });
    expect(await stored(message.id)).toMatchObject({ label: 'not_interested', labelSource: 'ai' });
  });
});
