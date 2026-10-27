/**
 * The default WeldAgent (/api/ai/chat and /chat/stream without an agentId):
 * read-only workspace tools gated by the caller's own permissions, multi-step
 * replies billed for every model request. The model is scripted; the tools
 * run against a real tenant schema (pglite).
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { schema } from '@weldsuite/worker-kit/db';

const hoisted = vi.hoisted(() => ({
  model: null as unknown,
  charges: [] as Array<{ modelId: string; usage: { inputTokens?: number; outputTokens?: number }; op: string }>,
}));

vi.mock('@weldsuite/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/ai')>();
  return {
    ...actual,
    isGatewayConfigured: () => true,
    // One scripted model instead of the gateway.
    runWithFallback: async (_env: unknown, _opts: unknown, run: (attempt: { model: unknown }) => unknown) => ({
      value: await run({ model: hoisted.model }),
    }),
    pickGateway: () => ({ model: hoisted.model, gateway: 'cloudflare', costFactor: 1, ai: { config: {} } }),
    gatewayCostFactor: () => 1,
  };
});

vi.mock('@weldsuite/core-domain/ai-billing', () => ({
  resolveAiMetering: vi.fn(async () => ({ metering: true })),
  assertAiCredits: vi.fn(async () => undefined),
  chargeAiUsage: vi.fn(
    async (_metering: unknown, params: { modelId: string; usage: { inputTokens?: number; outputTokens?: number }; op: string }) => {
      hoisted.charges.push(params);
      return 7;
    },
  ),
  InsufficientAiCreditsError: class extends Error {},
}));

const { aiRoutes } = await import('./index');

const ME = 'user_me';
const day = 24 * 60 * 60 * 1000;
const today = new Date().toISOString().slice(0, 10);

type Step = { tool?: { name: string; input: unknown }; text?: string };

/** A model that plays `script` one request at a time, for generate and stream alike. */
function scriptedModel(script: Step[]) {
  let call = 0;
  const usage = {
    inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 10, text: 10, reasoning: undefined },
  };
  const next = () => {
    const step = script[Math.min(call, script.length - 1)];
    call += 1;
    return { step, id: `call_${call}` };
  };
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const { step, id } = next();
      return {
        content: step.tool
          ? [{ type: 'tool-call' as const, toolCallId: id, toolName: step.tool.name, input: JSON.stringify(step.tool.input) }]
          : [{ type: 'text' as const, text: step.text ?? '' }],
        finishReason: { unified: step.tool ? ('tool-calls' as const) : ('stop' as const), raw: undefined },
        usage,
        warnings: [],
      };
    },
    doStream: async () => {
      const { step, id } = next();
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            if (step.tool) {
              controller.enqueue({ type: 'tool-call', toolCallId: id, toolName: step.tool.name, input: JSON.stringify(step.tool.input) });
            } else {
              controller.enqueue({ type: 'text-start', id: 't' });
              controller.enqueue({ type: 'text-delta', id: 't', delta: step.text ?? '' });
              controller.enqueue({ type: 'text-end', id: 't' });
            }
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: step.tool ? 'tool-calls' : 'stop', raw: undefined },
              usage,
            });
            controller.close();
          },
        }),
      };
    },
  });
}

describe('default WeldAgent (no agentId)', () => {
  let db: Awaited<ReturnType<typeof createPgliteDb>>['db'];

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    const now = new Date();
    await db.insert(schema.workspaceMembers).values([
      { id: 'wm_me', userId: ME, email: 'ann@example.com', name: 'Ann Me', role: 'MEMBER' },
      { id: 'wm_bob', userId: 'user_bob', email: 'bob@example.com', name: 'Bob Other', role: 'MEMBER' },
    ]);
    await db.insert(schema.projects).values([
      { id: 'prj_e2e', name: 'E2E Project', status: 'Active', createdAt: now, updatedAt: now },
      { id: 'prj_secret', name: 'Secret Project', status: 'Planning', createdAt: now, updatedAt: now },
    ]);
    await db.insert(schema.projectMembers).values({ id: 'pm_1', projectId: 'prj_e2e', userId: ME, role: 'member' });
    const base = { status: 'todo', priority: 'medium', position: 0 };
    await db.insert(schema.tasks).values([
      { ...base, id: 'task_1', number: 1, title: 'Overdue report', projectId: 'prj_e2e', assigneeId: ME, dueDate: new Date(Date.now() - day) },
      { ...base, id: 'task_2', number: 2, title: 'Done already', projectId: 'prj_e2e', assigneeId: ME, status: 'done', dueDate: new Date(Date.now() - day) },
      { ...base, id: 'task_3', number: 3, title: 'Secret plan', projectId: 'prj_secret', assigneeId: 'user_bob', dueDate: new Date(Date.now() - day) },
    ]);
  }, 120_000);

  beforeEach(() => {
    hoisted.charges.length = 0;
  });

  function app(...keys: string[]) {
    return createTestApp('/api/ai', aiRoutes, {
      context: { permissions: permissions(...keys), tenantDb: db, userId: ME },
      // No KV cache: the credit-state read is skipped (fee order), as without the binding in dev.
      env: { WORKSPACE_CACHE: undefined },
    });
  }

  const post = (request: ReturnType<typeof app>['request'], path: string, content: string) =>
    request(`/api/ai${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    });

  const plateScript: Step[] = [
    { tool: { name: 'list_tasks', input: { assignedToMe: true, includeDone: false, dueOnOrBefore: today } } },
    { text: 'You have 1 task due: Overdue report.' },
  ];

  const toolNames = (model: MockLanguageModelV4, request = 0, kind: 'generate' | 'stream' = 'generate') =>
    ((kind === 'generate' ? model.doGenerateCalls : model.doStreamCalls)[request].tools ?? [])
      .map((tool) => ('name' in tool ? tool.name : ''))
      .sort();

  it('looks the answer up with tools instead of inventing it (/chat)', async () => {
    const model = scriptedModel(plateScript);
    hoisted.model = model;
    const { request } = app('weldagent:use', 'agents:read', 'tasks:read', 'projects:read');

    const res = await post(request, '/chat', "What's on my plate today?");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { text: string; creditsUsed: number } };
    expect(body.data.text).toBe('You have 1 task due: Overdue report.');

    // Offered the read tools this user may use: tasks and projects, not people or tickets, nothing that writes.
    expect(toolNames(model)).toEqual(['get_project', 'list_projects', 'list_tasks']);
    // The system prompt carries the rules and today's date.
    const system = JSON.stringify(model.doGenerateCalls[0].prompt[0]);
    expect(system).toContain('Only state counts, names, records');
    expect(system).toContain(`Today is ${today}`);
    // The tool ran for real: its result (their task, not the done one or Bob's) reached the second request.
    const secondRequest = JSON.stringify(model.doGenerateCalls[1].prompt);
    expect(secondRequest).toContain('Overdue report');
    expect(secondRequest).not.toContain('Done already');
    expect(secondRequest).not.toContain('Secret plan');

    // Billed once, for both model requests.
    expect(hoisted.charges).toHaveLength(1);
    expect(hoisted.charges[0].usage).toMatchObject({ inputTokens: 200, outputTokens: 20 });
    expect(hoisted.charges[0].op).toBe('chat');
    expect(body.data.creditsUsed).toBe(7);
  });

  it('streams the same reply as plain text and bills every model request (/chat/stream)', async () => {
    const model = scriptedModel(plateScript);
    hoisted.model = model;
    const { request } = app('weldagent:use', 'agents:read', 'tasks:read', 'projects:read');

    const res = await post(request, '/chat/stream', "What's on my plate today?");
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('You have 1 task due: Overdue report.');

    expect(toolNames(model, 0, 'stream')).toEqual(['get_project', 'list_projects', 'list_tasks']);
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain('Overdue report');
    await vi.waitFor(() => expect(hoisted.charges).toHaveLength(1));
    expect(hoisted.charges[0].usage).toMatchObject({ inputTokens: 200, outputTokens: 20 });
  });

  it('gives the model only the tools the caller\'s own permissions cover', async () => {
    const model = scriptedModel([{ text: 'Here is a contact.' }]);
    hoisted.model = model;
    const { request } = app('weldagent:use', 'agents:read', 'people:read');

    await post(request, '/chat', 'Find a contact in the CRM');
    expect(toolNames(model)).toEqual(['get_person', 'list_people']);
    expect(JSON.stringify(model.doGenerateCalls[0].prompt[0])).not.toContain('list_tasks');
  });

  it('offers no tools, and says so, to a caller who may read nothing', async () => {
    const model = scriptedModel([{ text: "I can't see your workspace from here." }]);
    hoisted.model = model;
    const { request } = app('weldagent:use', 'agents:read', 'tasks:create');

    const res = await post(request, '/chat', 'Show my open tasks');
    expect(res.status).toBe(200);
    expect(model.doGenerateCalls[0].tools ?? []).toEqual([]);
    expect(JSON.stringify(model.doGenerateCalls[0].prompt[0])).toContain('no lookup tools for this user');
  });

  it('keeps the caller inside the projects they belong to unless they hold projects:scope:all', async () => {
    const model = scriptedModel([
      { tool: { name: 'list_projects', input: {} } },
      { text: 'One project.' },
    ]);
    hoisted.model = model;
    await post(app('weldagent:use', 'agents:read', 'projects:read').request, '/chat', 'List my projects');
    const seen = JSON.stringify(model.doGenerateCalls[1].prompt);
    expect(seen).toContain('E2E Project');
    expect(seen).not.toContain('Secret Project');

    const all = scriptedModel([
      { tool: { name: 'list_projects', input: {} } },
      { text: 'Two projects.' },
    ]);
    hoisted.model = all;
    await post(app('weldagent:use', 'agents:read', 'projects:read', 'projects:scope:all').request, '/chat', 'List projects');
    expect(JSON.stringify(all.doGenerateCalls[1].prompt)).toContain('Secret Project');
  });

  it('answers with an apology, not an empty reply, when the model writes nothing', async () => {
    hoisted.model = scriptedModel([{ text: '' }]);
    const res = await post(app('weldagent:use', 'agents:read', 'tasks:read').request, '/chat', 'Show my tasks');
    const body = (await res.json()) as { data: { text: string } };
    expect(body.data.text).toContain("couldn't finish");
  });
});
