/**
 * What one agent turn stores and tells the model: one stored step per tool
 * call, a question asked twice shown once, held actions without an id for the
 * model to repeat, and the presentation rules every agent carries.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createAgent } from './agents';
import { ASK_USER_TOOL_NAME, splitQuestionMarkers } from '@weldsuite/app-api-client/schemas/weldagent-questions';
import {
  PRESENTATION_RULES,
  buildSystemPrompt,
  customToolRunner,
  driveTurn,
  type DriveTurnParams,
  type StoredToolInvocation,
} from './executor';
import { PLATFORM_TOOLS, type PlatformToolDefinition, type ToolContext } from './tools';

const approvalNotices = vi.hoisted(() => vi.fn(async (_params: unknown) => 'notif_1'));
vi.mock('@weldsuite/notifications', () => ({ sendWeldAgentApprovalNotification: approvalNotices }));

const askUser = PLATFORM_TOOLS.find((tool) => tool.name === ASK_USER_TOOL_NAME)!;

const question = { question: 'When should I act?', options: [{ label: 'Daily' }, { label: 'On new tickets' }] };

function runner(
  tools: PlatformToolDefinition[],
  invocations: StoredToolInvocation[],
  context: Partial<ToolContext> = {},
  skipApprovals = false,
) {
  return customToolRunner(
    {
      toolContext: { db: {} as never, agentId: 'agt_1', actorUserId: 'user_1', workspaceId: 'org_1', ...context },
      agent: { autoReviewEnabled: false } as never,
      skipApprovals,
    },
    { allowedNow: tools, declared: tools, setup: false, canEdit: true, team: null, ref: { id: 'agent_obj', version: 1 } },
    invocations,
  );
}

describe('one stored step per tool call', () => {
  const listThings: PlatformToolDefinition = {
    id: 'things.list',
    name: 'list_things',
    description: 'List things',
    requiredPermissions: [],
    parameters: z.object({}),
    execute: async () => ({ things: [1, 2] }),
  };
  const failing: PlatformToolDefinition = { ...listThings, id: 'things.fail', name: 'fail_things', execute: async () => { throw new Error('boom'); } };

  it('records a finished call once, with its final state (not a call plus a result)', async () => {
    const invocations: StoredToolInvocation[] = [];
    const run = runner([listThings, failing], invocations);

    await run('list_things', {}, null);
    await run('fail_things', {}, null);

    expect(invocations).toEqual([
      { toolName: 'list_things', state: 'result', args: {}, result: { things: [1, 2] } },
      { toolName: 'fail_things', state: 'error', args: {}, result: { error: 'boom' } },
    ]);
  });
});

describe('asking the user a question', () => {
  it('answers the same question asked twice with the same ok result, and stores it once', async () => {
    const invocations: StoredToolInvocation[] = [];
    const run = runner([askUser], invocations);

    const first = await run(ASK_USER_TOOL_NAME, question, null);
    const second = await run(ASK_USER_TOOL_NAME, { ...question }, null);

    expect(first.isError).toBe(false);
    expect(second).toEqual(first);
    expect(second.result).toMatchObject({ ok: true, shownToUser: true });
    // One ask_user step, finished: no second call and no "already asked" error.
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({ toolName: ASK_USER_TOOL_NAME, state: 'result' });
    expect(invocations.filter((step) => step.state === 'error')).toEqual([]);
  });

  it('still refuses a different second question in the same turn', async () => {
    const invocations: StoredToolInvocation[] = [];
    const run = runner([askUser], invocations);

    await run(ASK_USER_TOOL_NAME, question, null);
    const other = await run(ASK_USER_TOOL_NAME, { question: 'And what else?', options: [{ label: 'A' }, { label: 'B' }] }, null);

    expect(other.isError).toBe(true);
    expect(invocations.map((step) => step.state)).toEqual(['result', 'error']);
  });

  it('lets the model ask again after a first attempt that failed', async () => {
    const invocations: StoredToolInvocation[] = [];
    const run = runner([askUser], invocations);

    // Fewer than two options: the tool refuses, which must not use up the turn's question.
    const bad = await run(ASK_USER_TOOL_NAME, { question: 'Hm?', options: [] }, null);
    expect(bad.isError).toBe(true);
    const good = await run(ASK_USER_TOOL_NAME, question, null);
    expect(good.isError).toBe(false);
  });
});

/** A fake session that replays `script` on the stream once the kickoff is sent. */
function fakeClient(script: Array<Record<string, unknown>>) {
  const sent: Array<Record<string, unknown>> = [];
  const client = {
    beta: {
      sessions: {
        events: {
          send: vi.fn(async (_id: string, body: { events: Array<Record<string, unknown>> }) => {
            sent.push(...body.events);
            return { data: body.events.map((event, i) => ({ ...event, id: `sent_${sent.length}_${i}` })) };
          }),
          stream: vi.fn(async () => ({
            controller: new AbortController(),
            async *[Symbol.asyncIterator]() {
              for (const event of script) yield event;
            },
          })),
          list: vi.fn(async function* () {}),
        },
        threads: { retrieve: vi.fn() },
      },
    },
  };
  return { client: client as unknown as DriveTurnParams['client'], sent };
}

const kickoff: DriveTurnParams['kickoff'] = [{ type: 'user.message', content: [{ type: 'text', text: 'Help' }] }];

describe('a question asked twice in one turn', () => {
  it('is shown to the user once and answered both times', async () => {
    const { client, sent } = fakeClient([
      { type: 'session.status_running', id: 'e1' },
      { type: 'agent.message', id: 'e2', content: [{ type: 'text', text: 'One more thing.' }] },
      { type: 'agent.custom_tool_use', id: 'e3', name: ASK_USER_TOOL_NAME, input: question },
      // The model sends the identical call again (a parallel tool call).
      { type: 'agent.custom_tool_use', id: 'e4', name: ASK_USER_TOOL_NAME, input: question },
      { type: 'session.status_idle', id: 'e5', stop_reason: { type: 'end_turn' } },
    ]);
    const invocations: StoredToolInvocation[] = [];
    let streamed = '';

    await driveTurn({
      client,
      sessionId: 'sesn_1',
      kickoff,
      deadline: Date.now() + 10_000,
      maxModelRequests: 10,
      invocations,
      onText: (text) => {
        streamed += text;
      },
      onCustomTool: runner([askUser], invocations),
    });

    expect(splitQuestionMarkers(streamed)).toEqual({ text: 'One more thing.', questions: [question] });
    const results = sent.filter((event) => event.type === 'user.custom_tool_result');
    expect(results).toHaveLength(2);
    expect(results.every((event) => event.is_error === false)).toBe(true);
    expect(invocations).toHaveLength(1);
  });
});

describe('sandbox and web calls', () => {
  it('are stored once each, completed by their result', async () => {
    const { client } = fakeClient([
      { type: 'session.status_running', id: 'e1' },
      { type: 'agent.tool_use', id: 'e2', name: 'web_search', input: { query: 'weld' }, evaluated_permission: 'allow' },
      { type: 'agent.tool_result', id: 'e3', tool_use_id: 'e2', content: [{ type: 'text', text: '3 results' }] },
      { type: 'agent.tool_use', id: 'e4', name: 'bash', input: { command: 'ls' }, evaluated_permission: 'allow' },
      { type: 'agent.tool_result', id: 'e5', tool_use_id: 'e4', is_error: true, content: [{ type: 'text', text: 'no such file' }] },
      { type: 'session.status_idle', id: 'e6', stop_reason: { type: 'end_turn' } },
    ]);
    const invocations: StoredToolInvocation[] = [];

    await driveTurn({
      client,
      sessionId: 'sesn_1',
      kickoff,
      deadline: Date.now() + 10_000,
      maxModelRequests: 10,
      invocations,
      onCustomTool: vi.fn(),
    });

    expect(invocations).toEqual([
      { toolName: 'web_search', state: 'result', args: { query: 'weld' }, result: '3 results' },
      { toolName: 'bash', state: 'error', args: { command: 'ls' }, result: 'no such file' },
    ]);
  });

  it('leave a call that never got a result as a call', async () => {
    const { client } = fakeClient([
      { type: 'session.status_running', id: 'e1' },
      { type: 'agent.tool_use', id: 'e2', name: 'web_search', input: {}, evaluated_permission: 'allow' },
      { type: 'session.status_idle', id: 'e3', stop_reason: { type: 'end_turn' } },
    ]);
    const invocations: StoredToolInvocation[] = [];
    await driveTurn({
      client,
      sessionId: 'sesn_1',
      kickoff,
      deadline: Date.now() + 10_000,
      maxModelRequests: 10,
      invocations,
      onCustomTool: vi.fn(),
    });
    expect(invocations.map((step) => step.state)).toEqual(['call']);
  });
});

describe('an action held for approval', () => {
  let db: Database;
  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  }, 120_000);

  const createTask = PLATFORM_TOOLS.find((tool) => tool.name === 'create_task')!;

  it('is stored with its approval and a plain label, and told to the model without an id', async () => {
    const invocations: StoredToolInvocation[] = [];
    const run = runner([createTask], invocations, { db, conversationId: 'conv_1' });

    const { result, isError } = await run('create_task', { title: 'QA agent chat task' }, null);

    expect(isError).toBe(false);
    // What the model reads: held, with the label, no id and no tool name to repeat.
    const told = JSON.stringify(result);
    expect(told).toContain('Create task \\"QA agent chat task\\"');
    expect(told).toContain('waiting for their approval');
    expect(told).not.toMatch(/apr_|approvalId|create_task/);

    // What is stored: one step the chat and the room render Approve / Reject from.
    expect(invocations).toHaveLength(1);
    const stored = invocations[0];
    expect(stored.state).toBe('result');
    expect(stored.result).toMatchObject({
      pendingApproval: true,
      approvalId: expect.stringMatching(/^apr_/),
      label: 'Create task "QA agent chat task"',
    });

    const [row] = await db.select().from(schema.weldagentApprovals);
    expect(row).toMatchObject({ toolName: 'create_task', status: 'pending', createdBy: 'user_1', conversationId: 'conv_1' });
    expect((stored.result as { approvalId: string }).approvalId).toBe(row.id);
  });

  it('tells the owner, and in a room also whoever asked, with what the action would do', async () => {
    const agent = await createAgent(db, { name: 'Room helper', createdBy: 'user_owner' });
    const invocations: StoredToolInvocation[] = [];
    approvalNotices.mockClear();
    const run = runner([createTask], invocations, {
      db,
      agentId: agent.id,
      actorUserId: 'user_asker',
      channelId: 'chan_room',
      env: {} as never,
    });

    await run('create_task', { title: 'QA agent chat task' }, null);

    const told = approvalNotices.mock.calls.map(([params]) => params as { userId: string; label: string; agentName: string; approvalId: string });
    expect(told.map((n) => n.userId).sort()).toEqual(['user_asker', 'user_owner']);
    for (const notice of told) {
      expect(notice).toMatchObject({ label: 'Create task "QA agent chat task"', agentName: 'Room helper' });
      expect(notice.approvalId).toMatch(/^apr_/);
    }
  });

  it('tells only the owner in a chat of the asker, and nobody when the owner asked there', async () => {
    const agent = await createAgent(db, { name: 'Chat helper', createdBy: 'user_owner' });
    approvalNotices.mockClear();
    const asOther = runner([createTask], [], { db, agentId: agent.id, actorUserId: 'user_asker', conversationId: 'conv_1', env: {} as never });
    await asOther('create_task', { title: 'One' }, null);
    expect(approvalNotices.mock.calls.map(([params]) => (params as { userId: string }).userId)).toEqual(['user_owner']);

    approvalNotices.mockClear();
    const asOwner = runner([createTask], [], { db, agentId: agent.id, actorUserId: 'user_owner', conversationId: 'conv_2', env: {} as never });
    await asOwner('create_task', { title: 'Two' }, null);
    expect(approvalNotices).not.toHaveBeenCalled();
  });

  it('runs straight away when approvals are switched off for the run', async () => {
    const invocations: StoredToolInvocation[] = [];
    const spy = vi.spyOn(createTask, 'execute').mockResolvedValueOnce({ id: 'task_1', title: 'Ran' });
    const run = runner([createTask], invocations, { db }, true);

    const { result } = await run('create_task', { title: 'Ran' }, null);

    expect(result).toEqual({ id: 'task_1', title: 'Ran' });
    expect(invocations).toEqual([{ toolName: 'create_task', state: 'result', args: { title: 'Ran' }, result: { id: 'task_1', title: 'Ran' } }]);
    spy.mockRestore();
  });
});

describe('what every agent is told about ids', () => {
  const agent = { id: 'agt_1', name: 'Helper', systemPrompt: 'When a new ticket arrives, triage it.' } as Parameters<typeof buildSystemPrompt>[0];

  it('never to show internal ids, tool names or raw field keys, but to name records', () => {
    expect(PRESENTATION_RULES).toContain('prj_…');
    expect(PRESENTATION_RULES).toContain('apr_…');
    expect(PRESENTATION_RULES).toContain('tool names');
    expect(PRESENTATION_RULES).toContain('name, title or number');
  });

  it('carries the rules into a working agent and a setup interview alike', () => {
    expect(buildSystemPrompt(agent)).toContain(PRESENTATION_RULES);
    expect(buildSystemPrompt({ ...agent, systemPrompt: '' })).toContain(PRESENTATION_RULES);
    // The agent's own instructions still follow.
    expect(buildSystemPrompt(agent)).toContain('When a new ticket arrives, triage it.');
  });
});
