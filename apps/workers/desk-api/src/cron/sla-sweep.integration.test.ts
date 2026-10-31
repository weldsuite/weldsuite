/**
 * The SLA engine end to end against pglite: a policy applies to a new inbox
 * conversation, the sweep warns and breaches exactly once per clock, an agent
 * reply meets the clock, and a workspace without policies writes nothing.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { appendDeskMessage, createDeskConversation } from '@weldsuite/db/lib/desk';
import { nextDeskSlaCheckAt } from '@weldsuite/db/lib/desk-sla';
import { sweepWorkspaceSla } from './sla-sweep';
import type { Env } from '../types';

let db: Database;
const env = { ENVIRONMENT: 'test' } as unknown as Env;
const ORG = 'org_test';

const minutesFrom = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);

async function addPolicy() {
  const now = new Date('2026-01-01T00:00:00Z');
  await db.insert(schema.helpdeskSlas).values({
    id: 'sla_standard',
    name: 'Standard',
    createdAt: now,
    updatedAt: now,
    isDefault: true,
    isActive: true,
    operationalHours: '24x7',
    firstResponseTime: [{ priority: 'medium', time: 60 }],
    resolutionTime: [{ priority: 'medium', time: 480 }],
    updateTime: [{ priority: 'medium', time: 120 }],
  });
}

const clocksOf = (conversationId: string) =>
  db.select().from(schema.deskSlaClocks).where(eq(schema.deskSlaClocks.conversationId, conversationId));

const slaEvents = (conversationId: string) =>
  db
    .select()
    .from(schema.deskMessages)
    .where(and(eq(schema.deskMessages.conversationId, conversationId), eq(schema.deskMessages.kind, 'event')))
    .then((rows) => rows.filter((r) => String(r.metadata?.eventType ?? '').startsWith('sla_')));

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.deskSlaClocks);
  await db.delete(schema.helpdeskSlas);
});

describe('desk SLA engine', () => {
  it('writes nothing when no policy applies', async () => {
    const { conversation, slaCheckAt } = await createDeskConversation(db, {
      generateId,
      visitorId: 'v_none',
      body: 'Hello?',
    });
    expect(slaCheckAt).toBeNull();
    expect(conversation.slaStatus).toBeNull();
    expect(await clocksOf(conversation.id)).toHaveLength(0);
  });

  it('starts clocks on the first visitor message and tells the caller when to check', async () => {
    await addPolicy();
    const { conversation, message, slaCheckAt } = await createDeskConversation(db, {
      generateId,
      visitorId: 'v_start',
      body: 'My invoice is wrong',
    });
    // Clocks start at the visitor's first message.
    const start = message.createdAt;

    expect(conversation).toMatchObject({ slaPolicyId: 'sla_standard', slaStatus: 'active', slaMetric: 'first_response' });
    expect(conversation.slaDueAt).toEqual(minutesFrom(start, 60));
    // The warning (75% of the hour) is the first thing the sweep has to look at.
    expect(slaCheckAt).toEqual(minutesFrom(start, 45));
    expect(await nextDeskSlaCheckAt(db)).toEqual(minutesFrom(start, 45));

    const metrics = (await clocksOf(conversation.id)).map((c) => c.metric).sort();
    expect(metrics).toEqual(['first_response', 'resolution']);
  });

  it('warns, then breaches, each once, and stops when the agent replies', async () => {
    await addPolicy();
    const { conversation, message } = await createDeskConversation(db, { generateId, visitorId: 'v_late', body: 'Help' });
    const start = message.createdAt;

    // Before anything is due: nothing to announce.
    expect(await sweepWorkspaceSla(env, db, ORG, minutesFrom(start, 30))).toBe(0);

    expect(await sweepWorkspaceSla(env, db, ORG, minutesFrom(start, 50))).toBe(1);
    expect(await sweepWorkspaceSla(env, db, ORG, minutesFrom(start, 55))).toBe(0);
    expect(await sweepWorkspaceSla(env, db, ORG, minutesFrom(start, 61))).toBe(1);
    expect(await sweepWorkspaceSla(env, db, ORG, minutesFrom(start, 70))).toBe(0);

    const events = await slaEvents(conversation.id);
    expect(events.map((e) => [e.metadata?.eventType, e.metadata?.metric])).toEqual([
      ['sla_warning', 'first_response'],
      ['sla_breached', 'first_response'],
    ]);
    // SLA events are internal and never pause, meet or restart a clock.
    const [first] = (await clocksOf(conversation.id)).filter((c) => c.metric === 'first_response');
    expect(first).toMatchObject({ status: 'running', breachedAt: minutesFrom(start, 60) });
    expect(first?.breachNotifiedAt).not.toBeNull();

    const reply = await appendDeskMessage(db, {
      generateId,
      conversationId: conversation.id,
      kind: 'message',
      authorType: 'agent',
      authorId: 'user_agent_1',
      body: 'Sorry for the wait',
    });
    // First response is over (missed); resolution waits on the customer.
    expect(reply.conversation.slaStatus).toBe('paused');
    expect(reply.slaCheckAt).toBeNull();
    const after = Object.fromEntries((await clocksOf(conversation.id)).map((c) => [c.metric, c]));
    expect(after.first_response).toMatchObject({ status: 'completed', nextCheckAt: null });
    expect(after.resolution).toMatchObject({ status: 'paused', dueAt: null, nextCheckAt: null });
  });

  it('retries an alert whose announcement failed instead of losing it', async () => {
    await addPolicy();
    const { conversation, message } = await createDeskConversation(db, { generateId, visitorId: 'v_flaky', body: 'Hi' });
    const start = message.createdAt;
    const failing = async () => {
      throw new Error('neon hiccup');
    };

    expect(await sweepWorkspaceSla(env, db, ORG, minutesFrom(start, 50), failing)).toBe(0);
    const [first] = (await clocksOf(conversation.id)).filter((c) => c.metric === 'first_response');
    // Not marked as warned, and looked at again 30 minutes later.
    expect(first).toMatchObject({ warnedAt: null, nextCheckAt: minutesFrom(start, 80) });
    expect(await slaEvents(conversation.id)).toHaveLength(0);

    // By then the clock has breached: the breach is announced, once.
    expect(await sweepWorkspaceSla(env, db, ORG, minutesFrom(start, 80))).toBe(1);
    expect((await slaEvents(conversation.id)).map((e) => e.metadata?.eventType)).toEqual(['sla_breached']);
  });

  it('re-derives the policy when the conversation is assigned', async () => {
    await addPolicy();
    const now = new Date('2026-01-01T00:00:00Z');
    await db.insert(schema.helpdeskSlas).values({
      id: 'sla_owned',
      name: 'Owned by Ann',
      createdAt: now,
      updatedAt: now,
      isActive: true,
      operationalHours: '24x7',
      conditions: [{ field: 'assigneeId', operator: 'equals', value: 'user_ann' }],
      firstResponseTime: [{ priority: 'medium', time: 10 }],
    });
    const { conversation, message } = await createDeskConversation(db, { generateId, visitorId: 'v_owned', body: 'Hi' });
    expect(conversation.slaPolicyId).toBe('sla_standard');

    const assigned = await appendDeskMessage(db, {
      generateId,
      conversationId: conversation.id,
      kind: 'event',
      authorType: 'agent',
      metadata: { eventType: 'assigned', assigneeId: 'user_ann' },
      assigneeId: 'user_ann',
    });
    expect(assigned.conversation).toMatchObject({ slaPolicyId: 'sla_owned', slaMetric: 'first_response' });
    expect(assigned.conversation.slaDueAt).toEqual(minutesFrom(message.createdAt, 10));
    expect(assigned.slaCheckAt).not.toBeNull();
  });

  it('starts a next-response cycle when the customer writes again', async () => {
    await addPolicy();
    const { conversation } = await createDeskConversation(db, { generateId, visitorId: 'v_cycle', body: 'Hi' });
    await appendDeskMessage(db, {
      generateId,
      conversationId: conversation.id,
      kind: 'message',
      authorType: 'agent',
      body: 'Hello!',
    });
    const followUp = await appendDeskMessage(db, {
      generateId,
      conversationId: conversation.id,
      kind: 'message',
      authorType: 'visitor',
      authorId: 'v_cycle',
      body: 'One more thing',
    });
    expect(followUp.conversation).toMatchObject({ slaStatus: 'active', slaMetric: 'next_response' });
    const next = (await clocksOf(conversation.id)).find((c) => c.metric === 'next_response');
    expect(next).toMatchObject({ status: 'running', startedAt: followUp.message.createdAt, targetMinutes: 120 });
  });

  it('retargets when the priority changes, and clears the clocks when no policy applies anymore', async () => {
    await addPolicy();
    await db
      .update(schema.helpdeskSlas)
      .set({ firstResponseTime: [{ priority: 'medium', time: 60 }, { priority: 'urgent', time: 15 }] })
      .where(eq(schema.helpdeskSlas.id, 'sla_standard'));
    const { conversation, message } = await createDeskConversation(db, { generateId, visitorId: 'v_prio', body: 'Down!' });

    await db
      .update(schema.deskConversations)
      .set({ priority: 'urgent' })
      .where(eq(schema.deskConversations.id, conversation.id));
    const urgent = await appendDeskMessage(db, {
      generateId,
      conversationId: conversation.id,
      kind: 'event',
      authorType: 'agent',
      metadata: { eventType: 'attributes_changed', changes: [] },
    });
    expect(urgent.conversation.slaDueAt).toEqual(minutesFrom(message.createdAt, 15));

    await db.update(schema.helpdeskSlas).set({ isActive: false });
    const none = await appendDeskMessage(db, {
      generateId,
      conversationId: conversation.id,
      kind: 'message',
      authorType: 'visitor',
      authorId: 'v_prio',
      body: 'Anyone?',
    });
    expect(none.conversation).toMatchObject({ slaPolicyId: null, slaStatus: null, slaDueAt: null });
    expect(await clocksOf(conversation.id)).toHaveLength(0);
  });
});
