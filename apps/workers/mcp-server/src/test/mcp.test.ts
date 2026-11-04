/**
 * The MCP endpoint end to end: the transport's checks, `initialize`,
 * `tools/list`, `tools/call` into the `/v1` copy (with name lookup, argument
 * validation, permission refusals and presentation), and the resources.
 * The `mcp-server` conformance suite runs this file against the Rust server
 * too (`rust/modules/mcp`).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { MCP_HEADERS, createMcpTestApp, currentTenantDb, testSession } from './harness';
import { allTools } from '../tools/registry';

vi.mock('../api/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/db')>()),
  createTenantDb: () => currentTenantDb(),
}));

/**
 * The `/v1` groups the Rust server serves to the MCP tools today (external-api's
 * ported groups, less the routes whose MCP copy differs). A session holding
 * only their objects sees the same tools on both backends.
 */
const SERVED_SEGMENTS = new Set([
  'people', 'companies', 'leads', 'opportunities', 'pipelines', 'pipeline-stages', 'activities', 'quotes',
  'tasks', 'time-entries', 'milestones', 'goals', 'sprints', 'task-comments', 'task-tags', 'project-documents',
  'project-files', 'project-labels', 'project-members', 'project-messages', 'whiteboards', 'articles', 'orders',
  'channels', 'channel-members', 'chat-messages', 'chat-bookmarks', 'chat-drafts', 'chat-sections', 'calendars',
  'calendar-events', 'social-accounts', 'social-campaigns', 'social-analytics', 'settings',
]);

const segment = (path: string) => path.split('/')[2] ?? '';
const objectOf = (scope: string) => scope.split(':')[0] ?? '';

/** Objects every tool of which is served: their read, create, update and delete. */
function servedPermissions(): string[] {
  const unserved = new Set(allTools.filter((tool) => !SERVED_SEGMENTS.has(segment(tool.path))).map((tool) => objectOf(tool.scope)));
  const objects = new Set(allTools.map((tool) => objectOf(tool.scope)).filter((object) => !unserved.has(object)));
  return [...objects].flatMap((object) => ['read', 'create', 'update', 'delete'].map((action) => `${object}:${action}`));
}

let db: Database;

beforeAll(async () => {
  ({ db } = await createPgliteDb());
});

afterAll(() => {
  (globalThis as Record<string, unknown>).__mcpTestTenantDb = undefined;
});

describe('mcp-server · transport', () => {
  it('answers initialize with the server, its instructions and capabilities', async () => {
    const { rpc } = createMcpTestApp({ tenantDb: db });
    const { status, body } = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(status).toBe(200);
    expect(body.result.serverInfo).toEqual({ name: 'WeldSuite', version: '1.0.0' });
    expect(body.result.protocolVersion).toBe('2025-06-18');
    const unknown = await rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(unknown.body.result.protocolVersion).toBe('2025-11-25');
  });

  it('answers ping, and -32601 for a method it does not have', async () => {
    const { rpc } = createMcpTestApp({ tenantDb: db });
    expect((await rpc('ping')).body.result).toEqual({});
    const missing = await rpc('prompts/list');
    expect(missing.body.error).toEqual({ code: -32601, message: 'Method not found' });
  });

  it("refuses what the transport refuses, in the SDK's order", async () => {
    const { request } = createMcpTestApp({ tenantDb: db });
    const message = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const noAccept = await request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: message });
    expect(noAccept.status).toBe(406);
    const wrongType = await request('/mcp', { method: 'POST', headers: { ...MCP_HEADERS, 'content-type': 'text/plain' }, body: message });
    expect(wrongType.status).toBe(415);
    const badVersion = await request('/mcp', { method: 'POST', headers: { ...MCP_HEADERS, 'mcp-protocol-version': '1999-01-01' }, body: message });
    expect(badVersion.status).toBe(400);
    const notJsonRpc = await request('/mcp', { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify({ hello: 'world' }) });
    expect(notJsonRpc.status).toBe(400);
    const malformed = await request('/mcp', { method: 'POST', headers: MCP_HEADERS, body: '{"jsonrpc":' });
    expect(malformed.status).toBe(500);
    const notification = await request('/mcp', {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe('');
  });

  it('answers a batch in order, GET with a closed stream and DELETE with 200', async () => {
    const { request } = createMcpTestApp({ tenantDb: db });
    const batch = await request('/mcp', {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 'a', method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 'b', method: 'resources/list' },
      ]),
    });
    expect(batch.status).toBe(200);
    const answers = (await batch.json()) as Array<{ id: string }>;
    expect(answers.map((answer) => answer.id)).toEqual(['a', 'b']);
    const stream = await request('/mcp', { method: 'GET', headers: { accept: 'text/event-stream' } });
    expect(stream.status).toBe(200);
    expect(await stream.text()).toBe('');
    const refused = await request('/mcp', { method: 'GET', headers: { accept: 'application/json' } });
    expect(refused.status).toBe(406);
    const closed = await request('/mcp', { method: 'DELETE' });
    expect(closed.status).toBe(200);
  });
});

describe('mcp-server · resources', () => {
  it('lists and reads the workspace resource', async () => {
    const { rpc } = createMcpTestApp({ tenantDb: db });
    const listed = await rpc('resources/list');
    expect(listed.body.result.resources[0].uri).toBe('weldsuite://workspace/info');
    expect((await rpc('resources/templates/list')).body.result).toEqual({ resourceTemplates: [] });
    const read = await rpc('resources/read', { uri: 'weldsuite://workspace/info' });
    expect(JSON.parse(read.body.result.contents[0].text)).toMatchObject({ workspaceId: 'ws_test', role: 'OWNER' });
    const missing = await rpc('resources/read', { uri: 'weldsuite://nothing' });
    expect(missing.body.error.code).toBe(-32602);
  });
});

describe('mcp-server · tools/list', () => {
  it("lists the tools the member's permissions can use", async () => {
    const { rpc } = createMcpTestApp({ tenantDb: db, session: testSession({ permissions: servedPermissions() }) });
    const { body } = await rpc('tools/list');
    const names = (body.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain('search_contacts');
    expect(names).not.toContain('search_tickets');
  });

  it('lists only reads for a read-only member', async () => {
    const { rpc } = createMcpTestApp({
      tenantDb: db,
      session: testSession({ permissions: ['customers:read', 'contacts:read'], role: 'VIEWER' }),
    });
    const { body } = await rpc('tools/list');
    const names = (body.result.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
    expect(names).toEqual(['get_contact', 'get_customer', 'search_contacts', 'search_customers']);
  });
});

describe('mcp-server · tools/call', () => {
  it('creates, finds by name, updates, lists and deletes a customer', async () => {
    const { callTool } = createMcpTestApp({ tenantDb: db });
    const created = await callTool('create_customer', { name: 'Zephyr Mcp Holdings', industry: 'Logistics', email: 'ops@zephyr.test' });
    expect(created.isError).toBe(false);
    expect(created.text).toContain('## Zephyr Mcp Holdings');

    // A name where an id is expected: the 404 is followed by a lookup.
    const byName = await callTool('get_customer', { customerId: 'Zephyr Mcp Holdings' });
    expect(byName.text).toContain('- Industry: Logistics');

    const updated = await callTool('update_customer', { customerId: 'Zephyr Mcp Holdings', industry: 'Freight' });
    expect(updated.text).toContain('- Industry: Freight');

    const listed = await callTool('search_customers', { search: 'Zephyr Mcp' });
    expect(listed.text).toMatch(/^1 result:\n1\. Zephyr Mcp Holdings/);

    const missing = await callTool('get_customer', { customerId: 'No Such Customer Anywhere' });
    expect(missing.isError).toBe(true);

    const deleted = await callTool('delete_customer', { customerId: 'Zephyr Mcp Holdings' });
    expect(deleted.text).toBe('- Success: yes');
  });

  it('creates and searches contacts and leads', async () => {
    const { callTool } = createMcpTestApp({ tenantDb: db });
    const contact = await callTool('create_contact', { firstName: 'Ada', lastName: 'Mcpherson', email: 'ada@mcpherson.test' });
    expect(contact.isError).toBe(false);
    const found = await callTool('search_contacts', { search: 'Mcpherson' });
    expect(found.text).toContain('Ada');
    const lead = await callTool('create_lead', { email: 'lead@mcp.test', firstName: 'Lena', companyName: 'Lead Co', status: 'new' });
    expect(lead.isError).toBe(false);
    const leads = await callTool('search_leads', { search: 'lead@mcp.test' });
    expect(leads.text).toContain('Lena');
  });

  it("words argument errors as the SDK does, and refuses tools it doesn't have", async () => {
    const { callTool } = createMcpTestApp({ tenantDb: db });
    const missing = await callTool('get_contact', {});
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe('MCP error -32602: Input validation error: Invalid arguments for tool get_contact: Required at contactId');
    const wrongType = await callTool('search_customers', { limit: 'many' });
    expect(wrongType.isError).toBe(true);
    const unknown = await callTool('no_such_tool', {});
    expect(unknown.text).toBe('MCP error -32602: Tool no_such_tool not found');
  });

  it("refuses a write the member's role cannot make", async () => {
    const { callTool } = createMcpTestApp({
      tenantDb: db,
      session: testSession({ permissions: ['customers:read', 'customers:create', 'companies:read', 'companies:create'], role: 'MEMBER' }),
    });
    const created = await callTool('create_customer', { name: 'Create Only Ltd' });
    expect(created.isError).toBe(false);
    const refused = await callTool('update_customer', { customerId: 'Create Only Ltd', industry: 'Nope' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('FORBIDDEN');
    const hidden = await callTool('delete_customer', { customerId: 'Create Only Ltd' });
    expect(hidden.text).toContain('FORBIDDEN');
  });

  it('works with chat and calendar objects', async () => {
    const { callTool } = createMcpTestApp({ tenantDb: db });
    const calendar = await callTool('create_calendar', { name: 'MCP calendar' });
    expect(calendar.isError).toBe(false);
    expect((await callTool('search_calendars', {})).text).toContain('MCP calendar');
    const channel = await callTool('create_channel', { name: 'mcp-port', type: 'public' });
    expect(channel.isError).toBe(false);
    expect((await callTool('search_channels', {})).text).toContain('mcp-port');
  });
});
