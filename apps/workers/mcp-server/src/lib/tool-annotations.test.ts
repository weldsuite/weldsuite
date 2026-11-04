/**
 * MCP tool annotations (TASK-1347): every tool on `tools/list` says whether it
 * only reads or may destroy data, static, WeldApp and WeldObjects tools alike.
 * Driven through `serveMcpRequest`, the transport `/mcp` uses.
 *
 * The dynamic loaders are stubbed with one WeldApp tool per action and one
 * custom object, so no database is reached.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './mcp-server';
import { serveMcpRequest } from './mcp-transport';
import type { McpSession } from './api-types';
import type { Env } from '../types/env';
import { allTools } from '../tools/registry';
import { annotationsFor, toolTitle } from './tool-annotations';

vi.mock('../tools/user-apps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/user-apps')>();
  const tool = (name: string, action: Record<string, unknown>) => ({
    appCode: 'stock',
    appName: 'Stock',
    name,
    description: name,
    parameters: null,
    action,
  });
  return {
    ...actual,
    loadUserAppTools: async () => [
      tool('list_items', { type: 'storage.list', collection: 'items' }),
      tool('add_item', { type: 'storage.create', collection: 'items' }),
      tool('edit_item', { type: 'storage.update', collection: 'items' }),
      tool('drop_item', { type: 'storage.delete', collection: 'items' }),
      tool('read_contacts', { type: 'api.request', method: 'get', path: '/v1/contacts' }),
      tool('odd_call', { type: 'api.request', method: 'TRACE', path: '/v1/contacts' }),
    ],
  };
});

vi.mock('../tools/custom-objects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/custom-objects')>();
  return {
    ...actual,
    loadCustomObjectTools: async () => [
      {
        slug: 'machines',
        entityKey: 'co_machines',
        labelSingular: 'Machine',
        labelPlural: 'Machines',
        description: null,
        fields: [],
      },
    ],
  };
});

const session: McpSession = {
  tokenId: 'oat_1',
  userId: 'user_1',
  clerkOrgId: 'org_1',
  workspaceId: 'ws_1',
  workspaceName: 'Acme',
  tier: 'business',
  databaseUrl: 'postgres://unused',
  permissions: ['*'],
  permissionDenies: [],
  role: 'OWNER',
  clientId: 'client_1',
  licensedApps: null,
};

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

async function listTools(): Promise<Tool[]> {
  const server = await createMcpServer(session, { CLERK_SECRET_KEY: 'sk_test_annotations' } as unknown as Env, ctx);
  const res = await serveMcpRequest(
    server,
    new Request('https://mcp.weldsuite.org/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
    undefined,
  );
  const body = (await res.json()) as { result: { tools: Tool[] } };
  return body.result.tools;
}

describe('MCP tool annotations', () => {
  it('lists every tool with a title and a read-only or destructive hint', async () => {
    const tools = await listTools();
    // Static tools, submit_feedback, six WeldApp tools and five WeldObjects tools.
    expect(tools).toHaveLength(allTools.length + 1 + 6 + 5);

    for (const tool of tools) {
      const hints = tool.annotations;
      // Clerk's submit_feedback sets `title` on the tool, not in its hints.
      expect(hints?.title ?? tool.title, tool.name).toBeTruthy();
      expect(typeof hints?.readOnlyHint, tool.name).toBe('boolean');
      // The spec defaults destructiveHint to true for a write: always say so.
      if (!hints?.readOnlyHint) expect(typeof hints?.destructiveHint, tool.name).toBe('boolean');
    }
  });

  it('marks static tools by their HTTP method', async () => {
    const byName = new Map((await listTools()).map((t) => [t.name, t.annotations]));
    for (const tool of allTools) {
      const hints = byName.get(tool.name);
      expect(hints?.readOnlyHint, tool.name).toBe(tool.method === 'GET');
      if (tool.method === 'DELETE') expect(hints?.destructiveHint, tool.name).toBe(true);
      if (/^(search|get|list)_/.test(tool.name)) expect(hints?.readOnlyHint, tool.name).toBe(true);
      if (/^create_/.test(tool.name)) expect(hints?.destructiveHint, tool.name).toBe(false);
    }

    expect(byName.get('search_tasks')).toEqual({
      title: 'Search tasks',
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(byName.get('update_task')).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(byName.get('delete_task')).toMatchObject({ destructiveHint: true });
  });

  it('keeps the hand-set overrides', async () => {
    const byName = new Map((await listTools()).map((t) => [t.name, t.annotations]));
    for (const name of ['publish_social_post', 'schedule_social_post', 'launch_reach_campaign', 'add_conversation_message']) {
      expect(byName.get(name), name).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    }
    for (const name of ['set_reach_campaign_steps', 'remove_reach_prospect_list_members']) {
      expect(byName.get(name), name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
  });

  it('derives WeldApp and WeldObjects hints from the call they make', async () => {
    const byName = new Map((await listTools()).map((t) => [t.name, t.annotations]));
    expect(byName.get('stock_list_items')).toMatchObject({ title: 'Stock: List items', readOnlyHint: true });
    expect(byName.get('stock_add_item')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get('stock_edit_item')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get('stock_drop_item')).toMatchObject({ destructiveHint: true });
    expect(byName.get('stock_read_contacts')).toMatchObject({ readOnlyHint: true });
    // An unknown method is refused at call time; until then assume the worst.
    expect(byName.get('stock_odd_call')).toMatchObject({ readOnlyHint: false, destructiveHint: true });

    expect(byName.get('list_machines')).toMatchObject({ title: 'List machines', readOnlyHint: true });
    expect(byName.get('create_machines')).toMatchObject({ destructiveHint: false });
    expect(byName.get('delete_machines')).toMatchObject({ destructiveHint: true });
  });
});

describe('annotationsFor', () => {
  it('lets overrides win over the method defaults', () => {
    expect(annotationsFor('POST', 'Send', { openWorldHint: true })).toEqual({
      title: 'Send',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it('titles a snake_case name', () => {
    expect(toolTitle('add_prospects_to_reach_campaign')).toBe('Add prospects to reach campaign');
  });
});
