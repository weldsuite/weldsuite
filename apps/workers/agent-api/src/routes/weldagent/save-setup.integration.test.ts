/**
 * save_agent_setup keeps an agent's status unless asked to activate (pglite).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createAgent, getAgent, updateAgent } from '@weldsuite/agent-domain/agents';
import { PLATFORM_TOOLS, type ToolContext } from '@weldsuite/agent-domain/tools';

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
    }) as Promise<{ ok?: boolean; status?: string }>;
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

  it('keeps a paused agent paused', async () => {
    const agent = await createAgent(db, { name: 'Paused', createdBy: 'user_1' });
    await updateAgent(db, agent.id, { status: 'paused' });

    expect(await save(agent.id)).toMatchObject({ ok: true, status: 'paused' });
  });
});
