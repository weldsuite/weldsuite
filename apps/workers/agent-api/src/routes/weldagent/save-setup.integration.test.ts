/**
 * save_agent_setup keeps an agent's status unless asked to activate, and only
 * subscribes it to events the user asked for (pglite).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createAgent, getAgent, updateAgent } from '@weldsuite/agent-domain/agents';
import { PLATFORM_TOOLS, type ToolContext } from '@weldsuite/agent-domain/tools';
import { EXPLICIT_TRIGGERS_FLAG } from '@weldsuite/agent-domain/subscriptions';

const saveSetup = PLATFORM_TOOLS.find((tool) => tool.id === 'agent.save_setup')!;

describe('save_agent_setup', () => {
  let db: Awaited<ReturnType<typeof createPgliteDb>>['db'];

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 120_000);

  const save = (agentId: string, activate?: boolean) => {
    const ctx: ToolContext = {
      db,
      agentId,
      actorUserId: 'user_1',
      workspaceId: 'org_1',
      actorPermissions: ['tasks:read'],
    };
    return saveSetup.execute(ctx, {
      name: 'Task Digest',
      systemPrompt: 'Every weekday at 8:00, send a digest of overdue tasks on a schedule.',
      permissions: ['tasks:read'],
      ...(activate === undefined ? {} : { activate }),
    }) as Promise<{ ok?: boolean; status?: string; hint?: string }>;
  };

  it('keeps an active agent active when the setup is saved again', async () => {
    const agent = await createAgent(db, { name: 'Digest', createdBy: 'user_1' });
    await updateAgent(db, agent.id, { status: 'active' });

    expect(await save(agent.id, false)).toMatchObject({ ok: true, status: 'active' });
    expect(await save(agent.id)).toMatchObject({ ok: true, status: 'active' });
    expect((await getAgent(db, agent.id))?.status).toBe('active');
  });

  it('leaves a new agent a draft, and activates only when asked', async () => {
    const agent = await createAgent(db, { name: 'New', createdBy: 'user_1' });

    expect(await save(agent.id, false)).toMatchObject({ ok: true, status: 'draft' });
    expect(await save(agent.id, true)).toMatchObject({ ok: true, status: 'active' });
  });

  describe('event triggers', () => {
    const CHAT_ONLY_PROMPT = [
      'You are the CRM QA Assistant and you answer questions about contacts in chat.',
      'You have no schedules or automatic triggers.',
      'Do not create new tasks unless asked.',
      'Never open new tickets yourself.',
      'When the user asks in chat, create a new person in the CRM.',
    ].join('\n');

    const saveWith = (agentId: string, systemPrompt: string, triggers?: string[]) => {
      const ctx: ToolContext = { db, agentId, actorUserId: 'user_1', workspaceId: 'org_1', actorPermissions: [] };
      return saveSetup.execute(ctx, {
        name: 'CRM QA Assistant',
        systemPrompt,
        ...(triggers === undefined ? {} : { triggers }),
      }) as Promise<{ ok?: boolean; eventSubscriptions?: string[]; unknownTriggers?: string[] }>;
    };

    it('keeps a chat-only agent manual: negated and "when asked" sentences are not triggers', async () => {
      const agent = await createAgent(db, { name: 'Chat only', createdBy: 'user_1' });
      const saved = await saveWith(agent.id, CHAT_ONLY_PROMPT);
      expect(saved).toMatchObject({ ok: true, eventSubscriptions: ['manual'] });
      expect((await getAgent(db, agent.id))?.eventSubscriptions).toEqual(['manual']);
    });

    it('subscribes to what the instructions plainly say', async () => {
      const agent = await createAgent(db, { name: 'Triage', createdBy: 'user_1' });
      const saved = await saveWith(agent.id, 'Whenever a new ticket comes in, triage it.');
      expect(saved.eventSubscriptions).toEqual(['ticket.created']);
    });

    it('uses the triggers the user asked for, instead of reading the prompt', async () => {
      const agent = await createAgent(db, { name: 'Explicit', createdBy: 'user_1' });
      const saved = await saveWith(agent.id, 'Work through the support ticket queue and keep it tidy.', [
        'ticket.created',
        'Person:Created',
      ]);
      expect(saved.eventSubscriptions).toEqual(['ticket.created', 'person.created']);
      const row = await getAgent(db, agent.id);
      expect(row?.eventSubscriptions).toEqual(['ticket.created', 'person.created']);
      expect(row?.enabledTools).toContain(EXPLICIT_TRIGGERS_FLAG);
    });

    it('an empty list means chat only, even when the prompt mentions things', async () => {
      const agent = await createAgent(db, { name: 'Explicit none', createdBy: 'user_1' });
      const saved = await saveWith(agent.id, 'Whenever a new ticket comes in, triage it.', []);
      expect(saved.eventSubscriptions).toEqual(['manual']);
    });

    it('keeps explicit triggers when the setup is saved again without them', async () => {
      const agent = await createAgent(db, { name: 'Sticky', createdBy: 'user_1' });
      await saveWith(agent.id, 'Work through the support ticket queue.', ['ticket.created']);
      const again = await saveWith(agent.id, 'Work through the support ticket queue, politely.');
      expect(again.eventSubscriptions).toEqual(['ticket.created']);
    });

    it('does not save triggers WeldSuite does not know, and says so', async () => {
      const agent = await createAgent(db, { name: 'Unknown', createdBy: 'user_1' });
      const saved = await saveWith(agent.id, 'Work through the support ticket queue.', ['ticket.created', 'widget.exploded']);
      expect(saved.eventSubscriptions).toEqual(['ticket.created']);
      expect(saved.unknownTriggers).toEqual(['widget.exploded']);
    });
  });

  it('keeps a paused agent paused', async () => {
    const agent = await createAgent(db, { name: 'Paused', createdBy: 'user_1' });
    await updateAgent(db, agent.id, { status: 'paused' });

    const saved = await save(agent.id);
    expect(saved).toMatchObject({ ok: true, status: 'paused' });
    // The model is told it is still paused, not that it is a draft.
    expect(saved.hint).toContain('still paused');
  });
});
