/**
 * The worker's service-binding routes on pglite: `/event` starts a
 * ConversationWorkflow (or answers busy), `/respond` hands a customer's answer
 * to the run waiting for it, and the AssignmentRouter routes (`/desk/assign`,
 * `/assign`, `/release`, `/sync-agents`). The run itself goes through
 * `FakeStep`, so a `/respond` reaches the very instance `/event` created.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgliteDb, pgliteClientOf } from '@weldsuite/worker-kit/testing/pglite';
import type { PGlite } from '@electric-sql/pglite';
import { CLEAR, CONVERSATION, executionRow, onCreated, workflowRow } from './testing/seed';
import { post, runInstance, testEnv } from './testing/harness';

const holder = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('./db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db')>()),
  getTenantDbForWorkspace: async () => holder.db,
}));

import worker from './index';

let client: PGlite;

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  return (await client.query<Record<string, unknown>>(sql)).rows;
}

beforeAll(async () => {
  const { db } = await createPgliteDb();
  holder.db = db;
  client = pgliteClientOf(db)!;
});

beforeEach(async () => {
  for (const statement of CLEAR) await client.exec(statement);
  await client.exec(CONVERSATION);
});

const choicesWorkflow = workflowRow({
  id: 'hwfl_choices',
  name: 'Triage',
  triggers: onCreated(),
  steps: [
    {
      id: 'ask',
      type: 'send_choices',
      name: 'Ask',
      order: 1,
      inputs: { message: 'What do you need?', options: [{ label: 'Billing', value: 'billing' }, { label: 'Other', value: 'other' }] },
    },
    { id: 'billing_note', type: 'add_internal_note', name: 'Note', order: 1, parentBranchId: 'ask_branch_billing', inputs: { content: 'Billing question' } },
    { id: 'other_note', type: 'add_internal_note', name: 'Note', order: 1, parentBranchId: 'ask_branch_other', inputs: { content: 'Other question' } },
    { id: 'bye', type: 'send_message', name: 'Bye', order: 2, inputs: { message: 'Thanks!' } },
  ],
});

describe('fetch', () => {
  it('answers service bindings only, and POST only', async () => {
    const { env } = testEnv();
    const publicHost = await worker.fetch(new Request('https://helpdesk-workflow-worker.weldsuite.workers.dev/event', { method: 'POST', body: '{}' }), env);
    expect(publicHost.status).toBe(404);
    const get = await worker.fetch(new Request('https://helpdesk-workflow-worker/event'), env);
    expect(get.status).toBe(405);
    const unknown = await worker.fetch(post('/nope', {}), env);
    expect(unknown.status).toBe(404);
  });
});

describe('POST /event', () => {
  it('starts a run with the event as trigger data', async () => {
    const { env, workflows } = testEnv();
    const res = await worker.fetch(
      post('/event', { type: 'conversation_created', conversationId: 'hc_1', workspaceId: 'org_1', data: { channel: 'chat', content: 'Hi' } }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ success: true, action: 'workflow_started', instanceId: 'wfi_1' });
    const { params } = workflows.last();
    expect(params).toMatchObject({
      workspaceId: 'org_1',
      conversationId: 'hc_1',
      eventType: 'conversation_created',
      channel: 'chat',
      triggerData: { channel: 'chat', content: 'Hi', conversationId: 'hc_1', workspaceId: 'org_1' },
    });
    expect(typeof params.triggerData.timestamp).toBe('string');
  });

  it('defaults the channel to web', async () => {
    const { env, workflows } = testEnv();
    await worker.fetch(post('/event', { type: 'message_received', conversationId: 'hc_1', workspaceId: 'org_1', data: {} }), env);
    expect(workflows.last().params.channel).toBe('web');
  });

  it('answers busy while an execution of the conversation is active', async () => {
    await client.exec(workflowRow({ id: 'hwfl_1', name: 'W', triggers: [], steps: [] }));
    await client.exec(executionRow({ id: 'wex_1', workflowId: 'hwfl_1', conversationId: 'hc_1', status: 'waiting_for_input' }));
    const { env, workflows } = testEnv();
    const res = await worker.fetch(post('/event', { type: 'message_received', conversationId: 'hc_1', workspaceId: 'org_1', data: {} }), env);
    expect(await res.json()).toEqual({ success: true, action: 'busy' });
    expect(workflows.instances.size).toBe(0);
  });

  it('hands a customer message to the run of an AI step, by its instance id', async () => {
    await client.exec(workflowRow({ id: 'hwfl_1', name: 'W', triggers: [], steps: [] }));
    await client.exec(executionRow({ id: 'wex_1', workflowId: 'hwfl_1', conversationId: 'hc_1', status: 'ai_active', context: { cfInstanceId: 'wfi_ai' } }));
    const { env, workflows } = testEnv();
    await workflows.create({ id: 'wfi_ai', params: {} });
    const res = await worker.fetch(
      post('/event', { type: 'message_received', conversationId: 'hc_1', workspaceId: 'org_1', data: { content: 'Still there?', authorName: 'Jane', messageId: 'm1' } }),
      env,
    );
    expect(await res.json()).toEqual({ success: true, action: 'ai_message_sent' });
    expect(workflows.instances.get('wfi_ai')!.sent).toEqual([
      { type: 'customer_message', payload: { content: 'Still there?', customerName: 'Jane', messageId: 'm1' } },
    ]);
  });
});

describe('POST /respond', () => {
  it('answers 404 when no execution of the conversation waits', async () => {
    const { env } = testEnv();
    const res = await worker.fetch(post('/respond', { conversationId: 'hc_1', workspaceId: 'org_1', executionId: 'x', stepId: 'ask' }), env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: 'No waiting execution found' });
  });

  it('resumes the run that waits for the answer, which then runs the chosen branch', async () => {
    await client.exec(choicesWorkflow);
    const { env, workflows, realtime } = testEnv();
    await worker.fetch(post('/event', { type: 'conversation_created', conversationId: 'hc_1', workspaceId: 'org_1', data: { channel: 'chat' } }), env);
    const instance = workflows.last();
    const run = runInstance(env, instance);
    await instance.whenParked();

    const [waiting] = await rows(`select id, status, current_step_id, execution_context from helpdesk_workflow_executions`);
    expect(waiting).toMatchObject({ status: 'waiting_for_input', current_step_id: 'ask' });
    expect((waiting!.execution_context as Record<string, unknown>).cfInstanceId).toBe(instance.id);

    const res = await worker.fetch(
      post('/respond', { conversationId: 'hc_1', workspaceId: 'org_1', executionId: waiting!.id, stepId: 'ask', selectedValue: 'billing', selectedLabel: 'Billing' }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, action: 'event_sent' });
    expect(await run.done).toEqual({ success: true, action: 'completed', workflowCount: 1 });

    const [done] = await rows(`select status, output from helpdesk_workflow_executions`);
    expect(done!.status).toBe('completed');
    const output = done!.output as Record<string, Record<string, unknown>>;
    expect(output.ask).toMatchObject({ stepId: 'ask', selectedValue: 'billing', selectedLabel: 'Billing', responded: true });
    expect(output.billing_note).toMatchObject({ success: true, conversationId: 'hc_1' });
    expect(output.other_note).toBeUndefined();
    const notes = await rows(`select content, type from helpdesk_conversation_messages where type = 'note'`);
    expect(notes).toEqual([{ content: 'Billing question', type: 'note' }]);
    const [conversation] = await rows(`select has_active_workflow from helpdesk_conversations where id = 'hc_1'`);
    expect(conversation!.has_active_workflow).toBe(false);
    expect(run.step.log.map((e) => e.name)).toEqual([
      'match-triggers',
      'set-active',
      'exec-create-hwfl_choices',
      'step-hwfl_choices-0-ask',
      'pause-hwfl_choices-0',
      'wait-hwfl_choices-0',
      'resume-hwfl_choices-0',
      'branch-hwfl_choices-0-0-billing_note',
      'step-hwfl_choices-1-bye',
      'complete-hwfl_choices',
      'finalize',
    ]);
    expect(realtime.publishes.map((p) => p.channel)).toEqual([
      'conversation:hc_1',
      'conversation:hc_1',
      'conversation:hc_1',
      'workspace:org_1',
    ]);
  });

  it('leaves the run to its timeout when nobody answers', async () => {
    await client.exec(choicesWorkflow);
    const { env, workflows } = testEnv();
    await worker.fetch(post('/event', { type: 'conversation_created', conversationId: 'hc_1', workspaceId: 'org_1', data: { channel: 'chat' } }), env);
    const instance = workflows.last();
    const run = runInstance(env, instance);
    await instance.whenParked();
    instance.timeOut();
    await expect(run.done).rejects.toThrow(/timed out/);
    const [execution] = await rows(`select status from helpdesk_workflow_executions`);
    expect(execution!.status).toBe('waiting_for_input');
  });
});

describe('POST /desk/assign', () => {
  const candidates = [
    { userId: 'user_cy', open: 0 },
    { userId: 'user_ann', open: 0 },
    { userId: 'user_bob', open: 0 },
  ];

  it('refuses a request without workspace, mode or candidates', async () => {
    const { env } = testEnv();
    for (const body of [{ mode: 'balanced', candidates }, { workspaceId: 'org_1', mode: 'off', candidates }, { workspaceId: 'org_1', mode: 'balanced' }]) {
      const res = await worker.fetch(post('/desk/assign', body), env);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'workspaceId, mode and candidates are required' });
    }
  });

  it('rotates round robin per workspace', async () => {
    const { env } = testEnv();
    const pick = async (workspaceId: string) =>
      ((await (await worker.fetch(post('/desk/assign', { workspaceId, mode: 'round_robin', candidates }), env)).json()) as { userId: string | null }).userId;
    expect(await pick('org_1')).toBe('user_ann');
    expect(await pick('org_1')).toBe('user_bob');
    expect(await pick('org_2')).toBe('user_ann');
    expect(await pick('org_1')).toBe('user_cy');
    expect(await pick('org_1')).toBe('user_ann');
  });

  it('counts recent picks towards the cap', async () => {
    const { env } = testEnv();
    const pick = async () =>
      ((await (await worker.fetch(post('/desk/assign', { workspaceId: 'org_1', mode: 'balanced', candidates: [{ userId: 'user_ann', open: 1 }], maxOpen: 2 }), env)).json()) as { userId: string | null }).userId;
    expect(await pick()).toBe('user_ann');
    expect(await pick()).toBeNull();
  });
});

describe('department router', () => {
  const agents = [
    { agentId: 'a1', userId: 'u1', name: 'Zed', maxActive: 2, currentActive: 0, isOnline: true, isAvailable: true },
    { agentId: 'a2', userId: 'u2', name: 'Amy', maxActive: 1, currentActive: 0, isOnline: true, isAvailable: true },
    { agentId: 'a3', userId: 'u3', name: 'Bea', maxActive: 3, currentActive: 0, isOnline: false, isAvailable: true },
  ];

  it('assigns in round robin by name, keeps counts across syncs and releases', async () => {
    const { env } = testEnv();
    const call = async (path: string, body: unknown) => (await worker.fetch(post(path, body), env)).json();
    expect(await call('/assign', { departmentId: 'dep_1', mode: 'round_robin' })).toEqual({ error: 'no_agents_available' });
    expect(await call('/sync-agents', { departmentId: 'dep_1', agents })).toEqual({ ok: true });
    expect(await call('/assign', { departmentId: 'dep_1', mode: 'round_robin' })).toEqual({ agentId: 'a2', userId: 'u2', name: 'Amy' });
    expect(await call('/assign', { departmentId: 'dep_1', mode: 'round_robin' })).toEqual({ agentId: 'a1', userId: 'u1', name: 'Zed' });
    // Amy is full now: Zed is the only one eligible.
    expect(await call('/assign', { departmentId: 'dep_1', mode: 'least_busy' })).toEqual({ agentId: 'a1', userId: 'u1', name: 'Zed' });
    expect(await call('/assign', { departmentId: 'dep_1', mode: 'least_busy' })).toEqual({ error: 'no_agents_available' });
    expect(await call('/sync-agents', { departmentId: 'dep_1', agents })).toEqual({ ok: true });
    expect(await call('/assign', { departmentId: 'dep_1', mode: 'least_busy' })).toEqual({ error: 'no_agents_available' });
    expect(await call('/release', { departmentId: 'dep_1', agentId: 'a2' })).toEqual({ ok: true });
    expect(await call('/assign', { departmentId: 'dep_1', mode: 'least_busy' })).toEqual({ agentId: 'a2', userId: 'u2', name: 'Amy' });
  });
});
