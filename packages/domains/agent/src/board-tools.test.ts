import { describe, expect, it } from 'vitest';
import { BOARD_TOOLS } from './board-tools';
import type { ToolContext } from './tools';

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function context(answer: (path: string, body: Record<string, unknown>) => { status: number; data?: unknown }) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    seen.push({ url, headers: init.headers as Record<string, string>, body });
    const path = new URL(url).pathname.replace(/^\/internal\/boards\/[^/]+/, '');
    const { status, data } = answer(path, body);
    return new Response(JSON.stringify(status >= 400 ? { error: { message: 'You can view this board but not change it' } } : { data }), { status });
  };
  const ctx = { db: {} as never, agentId: 'agt_1', actorUserId: 'user_1', workspaceId: 'ws_1', env: { BOARDS_INTERNAL: { fetch } } } as unknown as ToolContext;
  return { ctx, seen };
}

const tool = (name: string) => BOARD_TOOLS.find((t) => t.name === name)!;

describe('WeldAgent board tools', () => {
  it('act for the person, through BoardsInternal', async () => {
    const { ctx, seen } = context((path) => (path === '/find' ? { status: 200, data: { boards: [{ id: 'brd_1', name: 'Retro' }], total: 1, hasMore: false } } : { status: 404 }));
    expect(await tool('find_boards').execute(ctx, { query: 'retro' })).toMatchObject({ boards: [{ id: 'brd_1' }] });
    expect(seen[0]!.url).toBe('https://board-api/internal/boards/ws_1/find');
    expect(seen[0]!.headers['x-weld-user']).toBe('user_1');
    expect(seen[0]!.body).toEqual({ query: 'retro' });
  });

  it('create a board and put the content on it', async () => {
    const { ctx, seen } = context((path) =>
      path === '/create' ? { status: 201, data: { id: 'brd_2', name: 'Plan' } } : { status: 201, data: { revision: 1, elementIds: ['e1'], keys: {} } },
    );
    const content = { mindmap: { text: 'Plan', children: [{ text: 'Q1', children: [{ text: 'Hire' }] }] } };
    const result = await tool('create_board').execute(ctx, { name: 'Plan', content });
    expect(result).toMatchObject({ id: 'brd_2', content: { elementIds: ['e1'] } });
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(['/internal/boards/ws_1/create', '/internal/boards/ws_1/brd_2/add']);
    expect(seen[1]!.body).toEqual({ spec: content });
  });

  it('rename and edit, and pass board-api’s refusal on as an error', async () => {
    const { ctx, seen } = context((path) => (path.endsWith('/update') ? { status: 200, data: { name: 'Retro 2', url: '/weldboard/brd_1', row: {} } } : { status: 403 }));
    const result = await tool('update_board').execute(ctx, { boardId: 'brd_1', name: 'Retro 2', changes: [{ id: 'e1', text: 'x' }] });
    expect(result).toEqual({ error: 'You can view this board but not change it' });
    expect(seen.map((s) => new URL(s.url).pathname.split('/').at(-1))).toEqual(['update', 'edit']);
    expect(await tool('update_board').execute(ctx, { boardId: 'brd_1' })).toEqual({ error: 'Send a name or changes' });
  });

  it('say so where boards are not available', async () => {
    const ctx = { db: {} as never, agentId: 'agt_1', actorUserId: 'user_1', workspaceId: 'ws_1', env: {} } as unknown as ToolContext;
    expect(await tool('read_board').execute(ctx, { boardId: 'brd_1' })).toEqual({ error: 'Boards are not available to agents here' });
  });

  it('refuse a spec the board would not take before calling board-api', () => {
    expect(() => tool('add_to_board').parameters.parse({ boardId: 'brd_1', content: { items: [{ type: 'widget', text: 'x' }] } })).toThrow();
  });
});
