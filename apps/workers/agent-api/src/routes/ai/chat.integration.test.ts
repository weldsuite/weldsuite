/**
 * The assistant chat (/api/ai/chat, /chat/stream and /generate without an
 * agentId) over the mock model (`@weldsuite/ai/testing`): the model is an
 * OpenAI-compatible HTTP answer, so the same test runs on the Hono worker and
 * on the Rust backend (conformance suite `agent`). The tools run against a
 * real tenant schema (pglite). The mock answers by what the request holds,
 * never by call order.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockModel, type MockChatRequest } from '@weldsuite/ai/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { schema } from '@weldsuite/worker-kit/db';
import { aiRoutes } from './index';

const ME = 'user_me';
const day = 24 * 60 * 60 * 1000;

/** Looks tasks up when it can and nothing came back yet, then answers from the result. */
function answer(request: MockChatRequest) {
  const result = request.messages.find((message) => message.role === 'tool');
  if (result) {
    return { text: result.text.includes('Overdue report') ? 'You have 1 task: Overdue report.' : 'You have no tasks.' };
  }
  if (request.tools.includes('list_tasks')) {
    return { toolCalls: [{ name: 'list_tasks', arguments: { assignedToMe: true, includeDone: false } }] };
  }
  return { text: 'Hello from the model' };
}

describe('assistant chat over the mock model', () => {
  let db: Awaited<ReturnType<typeof createPgliteDb>>['db'];
  const mock = createMockModel({ chat: answer });

  beforeAll(async () => {
    vi.stubGlobal('fetch', mock.fetch);
    db = (await createPgliteDb()).db;
    const base = { status: 'todo', priority: 'medium', position: 0 };
    await db.insert(schema.tasks).values([
      { ...base, id: 'task_1', number: 1, title: 'Overdue report', assigneeId: ME, dueDate: new Date(Date.now() - day) },
      { ...base, id: 'task_2', number: 2, title: 'Done already', assigneeId: ME, status: 'done', dueDate: new Date(Date.now() - day) },
    ]);
  }, 120_000);

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  function app(...keys: string[]) {
    return createTestApp('/api/ai', aiRoutes, {
      context: { permissions: permissions(...keys), tenantDb: db, userId: ME },
      env: { WORKSPACE_CACHE: undefined, ...mock.env },
    });
  }

  const post = (request: ReturnType<typeof app>['request'], path: string, body: unknown) =>
    request(`/api/ai${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const hello = { messages: [{ role: 'user', content: 'Hello' }] };

  it('answers with the model text when the caller has nothing to look up (/chat)', async () => {
    const { request } = app('weldagent:use', 'agents:read');
    const res = await post(request, '/chat', hello);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { text: string; finishReason: string } };
    expect(body.data.text).toBe('Hello from the model');
    expect(body.data.finishReason).toBe('stop');
  });

  it('looks the answer up with a tool, as the caller, and answers from it (/chat)', async () => {
    const { request } = app('weldagent:use', 'agents:read', 'tasks:read');
    const res = await post(request, '/chat', { messages: [{ role: 'user', content: 'What is on my plate?' }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { text: string } };
    // Their open task, not the finished one.
    expect(body.data.text).toBe('You have 1 task: Overdue report.');
  });

  it('streams the reply as plain text (/chat/stream)', async () => {
    const { request } = app('weldagent:use', 'agents:read', 'tasks:read');
    const res = await post(request, '/chat/stream', { messages: [{ role: 'user', content: 'What is on my plate?' }] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('You have 1 task: Overdue report.');
  });

  it('folds system turns into the instructions and refuses a chat with no user turn', async () => {
    const { request } = app('weldagent:use', 'agents:read');
    const refused = await post(request, '/chat', { messages: [{ role: 'system', content: 'Be brief' }] });
    expect(refused.status).toBe(400);
    const ok = await post(request, '/chat', {
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'Hello' },
      ],
    });
    expect(ok.status).toBe(200);
  });

  it('generates text (/generate)', async () => {
    const { request } = app('agents:create');
    const res = await post(request, '/generate', { prompt: 'Say hello', system: 'Be brief', maxTokens: 50 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { text: string } };
    expect(body.data.text).toBe('Hello from the model');
  });

  it('refuses callers without the permission', async () => {
    const { request } = app('leads:read');
    expect((await post(request, '/chat', hello)).status).toBe(403);
    expect((await post(request, '/chat/stream', hello)).status).toBe(403);
    expect((await post(request, '/generate', { prompt: 'Hi' })).status).toBe(403);
  });
});
