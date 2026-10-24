import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  budgetForUsd,
  buildManagedTools,
  builtinToolAccess,
  listCostUsd,
  resolveManagedModel,
} from './managed-agents';
import { driveTurn, type DriveTurnParams } from './executor';
import type { PlatformToolDefinition } from './tools';
import { splitQuestionMarkers } from '@weldsuite/app-api-client/schemas/weldagent-questions';

describe('resolveManagedModel', () => {
  it('keeps Claude agent models', () => {
    expect(resolveManagedModel('claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
  });

  it('runs anything else on the default model', () => {
    expect(resolveManagedModel('@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBe('claude-opus-5-5');
    expect(resolveManagedModel(undefined)).toBe('claude-opus-5-5');
  });
});

describe('builtinToolAccess', () => {
  it('maps computer:use to the sandbox and browser:use to the web tools', () => {
    expect(builtinToolAccess(['computer:use'])).toEqual({ sandbox: true, web: false });
    expect(builtinToolAccess(['browser:use'])).toEqual({ sandbox: false, web: true });
    expect(builtinToolAccess(['people:read'])).toEqual({ sandbox: false, web: false });
  });
});

describe('buildManagedTools', () => {
  const def: PlatformToolDefinition = {
    id: 'people.list',
    name: 'list_people',
    description: 'List people',
    requiredPermissions: ['people:read'],
    parameters: z.object({ search: z.string().optional(), limit: z.number().int().optional() }),
    execute: async () => [],
  };

  it('declares platform tools as custom tools with a JSON schema', async () => {
    const tools = await buildManagedTools([def], { sandbox: false, web: false });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: 'custom',
      name: 'list_people',
      input_schema: { type: 'object', properties: { search: { type: 'string' } } },
    });
    expect(tools[0]).not.toHaveProperty('input_schema.$schema');
  });

  it('adds the agent toolset with only the granted built-in tools on', async () => {
    const tools = await buildManagedTools([], { sandbox: true, web: false });
    const toolset = tools[0] as { type: string; configs: Array<{ name: string; enabled: boolean }> };
    expect(toolset.type).toBe('agent_toolset_20260401');
    const enabled = toolset.configs.filter((c) => c.enabled).map((c) => c.name);
    expect(enabled).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep']);
  });
});

describe('money helpers', () => {
  it('reads list cost in cents', () => {
    expect(listCostUsd({ amount: '250', currency: 'USD' })).toBe(2.5);
    expect(listCostUsd(null)).toBe(0);
  });

  it('builds a whole-cent budget of at least one cent', () => {
    expect(budgetForUsd(2.501).max_list_cost.amount).toBe('251');
    expect(budgetForUsd(0).max_list_cost.amount).toBe('1');
  });
});

/** A fake session: replays `script` on the stream once the kickoff is sent. */
function fakeClient(script: Array<Record<string, unknown>>) {
  const sent: Array<Record<string, unknown>> = [];
  const client = {
    beta: {
      sessions: {
        events: {
          send: vi.fn(async (_id: string, body: { events: Array<Record<string, unknown>> }) => {
            sent.push(...body.events);
            return { data: body.events.map((ev, i) => ({ ...ev, id: `sent_${sent.length}_${i}` })) };
          }),
          stream: vi.fn(async () => ({
            controller: new AbortController(),
            async *[Symbol.asyncIterator]() {
              for (const ev of script) yield ev;
            },
          })),
          list: vi.fn(async function* () {}),
        },
        threads: {
          retrieve: vi.fn(async (id: string) => ({ id, agent: { id: `agent_for_${id}`, name: 'Researcher' } })),
        },
      },
    },
  };
  return { client: client as unknown as DriveTurnParams['client'], sent };
}

describe('driveTurn', () => {
  it('runs custom tools, denies unreviewed calls and collects the reply', async () => {
    const { client, sent } = fakeClient([
      { type: 'session.status_running', id: 'e1' },
      { type: 'span.model_request_start', id: 'e2' },
      { type: 'agent.custom_tool_use', id: 'e3', name: 'list_people', input: { limit: 1 } },
      { type: 'agent.tool_use', id: 'e4', name: 'bash', input: { command: 'ls' }, evaluated_permission: 'ask' },
      { type: 'session.status_idle', id: 'e5', stop_reason: { type: 'requires_action' } },
      {
        type: 'span.model_request_end',
        id: 'e6',
        model_usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      { type: 'agent.message', id: 'e7', content: [{ type: 'text', text: 'Found 1 person.' }] },
      { type: 'session.status_idle', id: 'e8', stop_reason: { type: 'end_turn' } },
    ]);
    const onCustomTool = vi.fn(async () => ({ result: [{ id: 'per_1' }], isError: false }));

    const outcome = await driveTurn({
      client,
      sessionId: 'sesn_1',
      kickoff: [{ type: 'user.message', content: [{ type: 'text', text: 'Who is there?' }] }],
      deadline: Date.now() + 10_000,
      maxModelRequests: 10,
      invocations: [],
      onCustomTool,
    });

    expect(onCustomTool).toHaveBeenCalledWith('list_people', { limit: 1 }, null);
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'user.custom_tool_result', custom_tool_use_id: 'e3', is_error: false }),
    );
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'user.tool_confirmation', tool_use_id: 'e4', result: 'deny' }),
    );
    expect(outcome.texts).toEqual(['Found 1 person.']);
    expect(outcome.finishReason).toBe('end_turn');
    expect(outcome.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it('streams an ask_user question inline for the client to render', async () => {
    const question = { question: 'When should I act?', options: [{ label: 'Daily' }, { label: 'On new tickets' }] };
    const { client } = fakeClient([
      { type: 'session.status_running', id: 'e1' },
      { type: 'agent.message', id: 'e2', content: [{ type: 'text', text: 'One more thing.' }] },
      { type: 'agent.custom_tool_use', id: 'e3', name: 'ask_user', input: question },
      { type: 'session.status_idle', id: 'e4', stop_reason: { type: 'end_turn' } },
    ]);
    let streamed = '';

    await driveTurn({
      client,
      sessionId: 'sesn_1',
      kickoff: [{ type: 'user.message', content: [{ type: 'text', text: 'Help with support' }] }],
      deadline: Date.now() + 10_000,
      maxModelRequests: 10,
      invocations: [],
      onText: (text) => {
        streamed += text;
      },
      onCustomTool: async () => ({ result: { ok: true }, isError: false }),
    });

    expect(splitQuestionMarkers(streamed)).toEqual({ text: 'One more thing.', questions: [question] });
  });

  it('interrupts once the model-request cap is passed', async () => {
    const { client, sent } = fakeClient([
      { type: 'span.model_request_start', id: 'e1' },
      { type: 'span.model_request_start', id: 'e2' },
      { type: 'session.status_idle', id: 'e3', stop_reason: { type: 'end_turn' } },
    ]);

    const outcome = await driveTurn({
      client,
      sessionId: 'sesn_1',
      kickoff: [{ type: 'user.message', content: [{ type: 'text', text: 'Go' }] }],
      deadline: Date.now() + 10_000,
      maxModelRequests: 1,
      invocations: [],
      onCustomTool: vi.fn(),
    });

    expect(sent).toContainEqual({ type: 'user.interrupt' });
    expect(outcome.finishReason).toBe('max_iterations');
  });

  it('interrupts and throws when the caller cancels', async () => {
    const { client, sent } = fakeClient([{ type: 'session.status_running', id: 'e1' }]);
    const cancel = new AbortController();
    cancel.abort();

    await expect(
      driveTurn({
        client,
        sessionId: 'sesn_1',
        kickoff: [{ type: 'user.message', content: [{ type: 'text', text: 'Go' }] }],
        deadline: Date.now() + 10_000,
        maxModelRequests: 5,
        invocations: [],
        onCustomTool: vi.fn(),
        signal: cancel.signal,
      }),
    ).rejects.toThrow('cancelled');
    expect(sent).toContainEqual({ type: 'user.interrupt' });
  });

  it('weights cached input tokens by their list price', async () => {
    const { client } = fakeClient([
      { type: 'session.status_running', id: 'e1' },
      {
        type: 'span.model_request_end',
        id: 'e2',
        model_usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 },
      },
      { type: 'session.status_idle', id: 'e3', stop_reason: { type: 'end_turn' } },
    ]);

    const outcome = await driveTurn({
      client,
      sessionId: 'sesn_1',
      kickoff: [{ type: 'user.message', content: [{ type: 'text', text: 'Go' }] }],
      deadline: Date.now() + 10_000,
      maxModelRequests: 5,
      invocations: [],
      onCustomTool: vi.fn(),
    });

    expect(outcome.usage.inputTokens).toBe(1110);
    expect(outcome.pricedInputTokens).toBe(10 + 1000 * 0.1 + 100 * 1.25);
  });

  it('routes a sub-agent thread\'s calls and records the delegation', async () => {
    const { client, sent } = fakeClient([
      { type: 'session.status_running', id: 'e1' },
      { type: 'session.thread_created', id: 'e2', session_thread_id: 'sthr_1', agent_name: 'Researcher', workflow_run_id: null },
      {
        type: 'agent.thread_message_sent',
        id: 'e3',
        to_session_thread_id: 'sthr_1',
        to_agent_name: 'Researcher',
        content: [{ type: 'text', text: 'Find the latest invoices' }],
      },
      { type: 'agent.custom_tool_use', id: 'e4', name: 'list_invoices', input: {}, session_thread_id: 'sthr_1' },
      { type: 'agent.tool_use', id: 'e5', name: 'web_search', input: {}, evaluated_permission: 'ask', session_thread_id: 'sthr_1' },
      { type: 'agent.tool_use', id: 'e6', name: 'bash', input: {}, evaluated_permission: 'ask', session_thread_id: 'sthr_1' },
      {
        type: 'agent.thread_message_received',
        id: 'e7',
        from_session_thread_id: 'sthr_1',
        from_agent_name: 'Researcher',
        content: [{ type: 'text', text: 'Three invoices are open.' }],
      },
      { type: 'agent.message', id: 'e8', content: [{ type: 'text', text: 'You have three open invoices.' }] },
      { type: 'session.status_idle', id: 'e9', stop_reason: { type: 'end_turn' } },
    ]);
    const onCustomTool = vi.fn(async () => ({ result: [], isError: false }));
    const invocations: DriveTurnParams['invocations'] = [];

    await driveTurn({
      client,
      sessionId: 'sesn_1',
      kickoff: [{ type: 'user.message', content: [{ type: 'text', text: 'Any open invoices?' }] }],
      deadline: Date.now() + 10_000,
      maxModelRequests: 10,
      invocations,
      onCustomTool,
      // Web allowed, sandbox not.
      allowSubagentBuiltin: (_agent, tool) => tool === 'web_search',
    });

    // Identified by the thread's agent object, read once and cached.
    expect(onCustomTool).toHaveBeenCalledWith('list_invoices', {}, { name: 'Researcher', objectId: 'agent_for_sthr_1' });
    expect(sent).toContainEqual(expect.objectContaining({ tool_use_id: 'e5', result: 'allow' }));
    expect(sent).toContainEqual(expect.objectContaining({ tool_use_id: 'e6', result: 'deny' }));
    expect(invocations).toEqual([
      { toolName: 'delegate_to_agent', state: 'call', args: { agent: 'Researcher', task: 'Find the latest invoices' } },
      { toolName: 'delegate_to_agent', state: 'result', args: { agent: 'Researcher' }, result: 'Three invoices are open.' },
    ]);
  });

  it('reports a failed session', async () => {
    const { client } = fakeClient([
      { type: 'session.status_running', id: 'e1' },
      { type: 'session.error', id: 'e2', error: { type: 'model_overloaded_error', message: 'Overloaded' } },
      { type: 'session.status_idle', id: 'e3', stop_reason: { type: 'retries_exhausted' } },
    ]);

    const outcome = await driveTurn({
      client,
      sessionId: 'sesn_1',
      kickoff: [{ type: 'user.message', content: [{ type: 'text', text: 'Go' }] }],
      deadline: Date.now() + 10_000,
      maxModelRequests: 5,
      invocations: [],
      onCustomTool: vi.fn(),
    });

    expect(outcome.finishReason).toBe('error');
    expect(outcome.error).toBe('Overloaded');
  });
});
