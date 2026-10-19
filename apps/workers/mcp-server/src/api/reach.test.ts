/**
 * WeldReach through the MCP server's own API, in process, against pglite.
 *
 * The requests go through `apiApp.fetch()` (what `lib/proxy.ts` does for a tool
 * call) and through `executeTool` itself, so the real session translation, the
 * real approval gate (`reachAccess`), the real permission mapping and the real
 * domain code run. Only what Cloudflare would provide is faked: the tenant DB
 * (pglite instead of Neon), `WORKSPACE_CACHE` (holding the cached access row),
 * `SCHEDULE_INDEX` (a SQLite D1), and the entity-event queue.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { eq } from 'drizzle-orm';
import { reachProspects, reachSuppressions } from '@weldsuite/db/schema';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { AppAccess } from '@weldsuite/worker-kit/app-access';
import type { Database } from '@weldsuite/worker-kit/db';
import { createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { resetReach, seedCampaign, seedEnrollment, seedMailbox, seedProspect, seedSettings } from '@weldsuite/reach-domain/testing/reach';
import type { McpSession } from '../lib/api-types';
import type { Env } from '../types/env';

// The one seam: the tenant DB is pglite, not a Neon connection.
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('./db', async (importOriginal) => ({ ...(await importOriginal<typeof import('./db')>()), createTenantDb: () => holder.db }));

import { INTERNAL_ORIGIN, apiApp, internalEnv } from './app';
import { executeTool } from '../lib/proxy';
import { createMcpServer } from '../lib/mcp-server';
import { reachTools } from '../tools/reach';

const ORG_ID = 'org_mcp_reach';
const WORKSPACE_ID = 'ws_mcp_reach';

const DUE_INDEX_MIGRATION = readFileSync(resolve(__dirname, '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'), 'utf8');

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  holder.db = db;
}, 60_000);

beforeEach(async () => {
  await resetReach(db);
});

afterAll(() => vi.unstubAllGlobals());

/** The access row staff leave on a workspace, with `overrides` on top. */
function accessRow(overrides: Partial<AppAccess> = {}): AppAccess {
  return { workspaceId: WORKSPACE_ID, status: 'approved', limits: {}, billingStatus: 'active', billingStatusAt: null, ...overrides };
}

/** A KV namespace holding the cached `appaccess:<org>:weldreach` row (none: a miss, which would open master). */
function accessCache(access: AppAccess | null): KVNamespace {
  const entries = new Map<string, unknown>();
  if (access) entries.set(`appaccess:${ORG_ID}:weldreach`, access);
  return {
    get: async (key: string, type?: string) => {
      const value = entries.get(key);
      if (value === undefined) return null;
      return type === 'json' ? value : JSON.stringify(value);
    },
    put: async (key: string, value: string) => {
      entries.set(key, JSON.parse(value));
    },
  } as unknown as KVNamespace;
}

function session(permissions: string[], denies: string[] = []): McpSession {
  return {
    tokenId: 'tok_mcp_reach',
    userId: 'user_mcp_reach',
    clerkOrgId: ORG_ID,
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Acme',
    tier: 'enterprise',
    databaseUrl: 'postgresql://unused.invalid/db',
    permissions,
    permissionDenies: denies,
    role: 'ADMIN',
    clientId: null,
    licensedApps: null,
  };
}

/** The JSON body of a response; an unrouted path answers Hono's plain "404 Not Found". */
function parsed(text: string): any {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/** One request's world: the bindings, the events they collected and the helpers to call the API with. */
function world(options: { access?: AppAccess | null; env?: Partial<Env> } = {}) {
  const events: EntityEventMessage[] = [];
  const pending: Promise<unknown>[] = [];
  const d1 = createSqliteD1(DUE_INDEX_MIGRATION);
  const env = {
    ENVIRONMENT: 'test',
    DATABASE_URL_MASTER: 'not a connection string',
    WORKSPACE_CACHE: accessCache(options.access === undefined ? accessRow() : options.access),
    SCHEDULE_INDEX: d1,
    ENTITY_EVENTS: { send: async (message: EntityEventMessage) => void events.push(message) } as unknown as Queue<EntityEventMessage>,
    ...options.env,
  } as unknown as Env;
  const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise), passThroughOnException: () => undefined } as unknown as ExecutionContext;

  /** A call into the internal API, as a tool call makes it. */
  async function call(who: McpSession, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await apiApp.fetch(
      new Request(new URL(path, INTERNAL_ORIGIN).toString(), {
        method,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      internalEnv(env, who),
      ctx,
    );
    await Promise.all(pending.splice(0));
    const text = await res.text();
    return { status: res.status, body: parsed(text) };
  }

  /** A real MCP client connected to the server this session would get, over an in-memory transport. */
  async function client(who: McpSession): Promise<Client> {
    const server = await createMcpServer(who, env, ctx);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const connected = new Client({ name: 'reach-test', version: '1.0.0' });
    await Promise.all([server.connect(serverSide), connected.connect(clientSide)]);
    return connected;
  }

  /** A tool call, through the executor the MCP server uses. */
  async function tool(who: McpSession, name: string, args: Record<string, unknown> = {}) {
    const definition = reachTools.find((t) => t.name === name);
    if (!definition) throw new Error(`no tool ${name}`);
    const result = await executeTool(definition, args, who, env, ctx);
    await Promise.all(pending.splice(0));
    return { isError: result.isError === true, text: (result.content[0] as { text: string }).text };
  }

  const dueRow = () =>
    d1.prepare("SELECT workspace_id AS workspaceId FROM workspace_due_index WHERE kind = 'reach_send'").first<{ workspaceId: string }>();

  return { call, tool, client, events, dueRow };
}

/** Prospect validation looks up MX records over DNS-over-HTTPS (global `fetch`): every domain can receive mail. */
function stubDns() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const name = new URL(String(input)).searchParams.get('name') ?? '';
    return new Response(JSON.stringify({ Status: 0, Answer: [{ name: `${name}.`, type: 15, TTL: 60, data: `10 mx.${name}.` }] }), {
      headers: { 'Content-Type': 'application/dns-json' },
    });
  });
}

const OWNER = ['*'];
const OWNER_REACH = ['reach_campaigns:*', 'reach_prospects:*', 'reach_settings:*', 'reach_inbox:*', 'reach_mailboxes:*'];

describe('the approval gate', () => {
  it.each(['requested', 'rejected', 'suspended', 'revoked', 'none'] as const)('answers 403 APP_ACCESS_REQUIRED for a workspace whose access is %s', async (status) => {
    const w = world({ access: accessRow({ status }) });
    for (const [method, path] of [
      ['GET', '/v1/reach/access'],
      ['GET', '/v1/reach/overview'],
      ['GET', '/v1/reach/campaigns'],
      ['GET', '/v1/reach/threads'],
      ['GET', '/v1/reach/mailboxes'],
      ['POST', '/v1/reach/prospects'],
      ['DELETE', '/v1/reach/suppressions/rsup_x'],
    ] as const) {
      const res = await w.call(session(OWNER), method, path, method === 'POST' ? { email: 'jane@acme.nl' } : undefined);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error, `${method} ${path}`).toMatchObject({ code: 'APP_ACCESS_REQUIRED', details: { appCode: 'weldreach', status } });
    }
    // Refused before anything ran: nothing was written, no event, no sweep wake-up.
    expect(await db.select().from(reachProspects)).toHaveLength(0);
    expect(w.events).toHaveLength(0);
  });

  it('refuses a tool call the same way, as a tool error an agent can act on', async () => {
    const w = world({ access: accessRow({ status: 'suspended' }) });
    const result = await w.tool(session(OWNER), 'search_reach_campaigns');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('APP_ACCESS_REQUIRED');
    expect(result.text).toContain('weldreach');
    expect(result.text).toContain('suspended');
  });

  it('never lets a request through when the access cannot be read (a 500, not a pass)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // Nothing cached, and master cannot be reached.
      const w = world({ access: null });
      const res = await w.call(session(OWNER), 'GET', '/v1/reach/campaigns');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    } finally {
      spy.mockRestore();
    }
  });

  it('lets an approved workspace in', async () => {
    const res = await world().call(session(OWNER), 'GET', '/v1/reach/access');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'approved', sendingEnabled: true });
  });
});

describe('reads and writes with the right permission', () => {
  it('lists campaigns with reach_campaigns:read', async () => {
    await seedCampaign(db, { campaign: { name: 'Q4 logistics', status: 'draft' } });
    const res = await world().call(session(['reach_campaigns:read']), 'GET', '/v1/reach/campaigns');
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { name: string }) => c.name)).toEqual(['Q4 logistics']);
    expect(res.body.pagination).toMatchObject({ totalCount: 1, hasMore: false });
  });

  it('refuses a read without it, and a read of another WeldReach object does not help', async () => {
    const w = world();
    expect((await w.call(session(['reach_prospects:read']), 'GET', '/v1/reach/campaigns')).status).toBe(403);
    expect((await w.call(session([]), 'GET', '/v1/reach/campaigns')).status).toBe(403);
    expect((await w.call(session(['reach_campaigns:read']), 'GET', '/v1/reach/domains')).status).toBe(403);
    expect((await w.call(session(['reach_mailboxes:read']), 'GET', '/v1/reach/domains')).status).toBe(200);
    expect((await w.call(session(['reach_inbox:read']), 'GET', '/v1/reach/threads')).status).toBe(200);
  });

  it('creates a prospect with reach_prospects:create and publishes the entity event', async () => {
    stubDns();
    const w = world();
    const res = await w.call(session(['reach_prospects:create']), 'POST', '/v1/reach/prospects', { email: 'Jane@Acme.nl', firstName: 'Jane' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: 'jane@acme.nl', firstName: 'Jane', validation: 'valid' });

    const [row] = await db.select().from(reachProspects).where(eq(reachProspects.email, 'jane@acme.nl'));
    expect(row?.id).toBe(res.body.data.id);

    const created = w.events.filter((e) => e.entityType === 'reach_prospect' && e.action === 'created');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ entityId: res.body.data.id, metadata: { workspaceId: ORG_ID, userId: 'user_mcp_reach' } });
  });

  it('refuses to create a prospect on update alone (the app asks for create), and on a read grant', async () => {
    stubDns();
    const w = world();
    for (const permissions of [['reach_prospects:update'], ['reach_prospects:read'], ['reach_prospects:delete']]) {
      const res = await w.call(session(permissions), 'POST', '/v1/reach/prospects', { email: 'jane@acme.nl' });
      expect(res.status, permissions.join()).toBe(403);
    }
    expect(await db.select().from(reachProspects)).toHaveLength(0);
  });

  it('answers a validation failure with the documented 400 envelope', async () => {
    const res = await world().call(session(OWNER), 'POST', '/v1/reach/prospects', { email: 'not an email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});

describe('DELETE routes follow the app, not the verb', () => {
  it('removes a suppression with reach_settings:update (reach_settings has no delete)', async () => {
    const w = world();
    const added = await w.call(session(['reach_settings:update']), 'POST', '/v1/reach/suppressions', { values: ['blocked@acme.nl'] });
    expect(added.status).toBe(201);
    const [entry] = await db.select().from(reachSuppressions);
    expect(entry?.value).toBe('blocked@acme.nl');

    // Read alone does not remove it.
    expect((await w.call(session(['reach_settings:read']), 'DELETE', `/v1/reach/suppressions/${entry?.id}`)).status).toBe(403);
    expect(await db.select().from(reachSuppressions)).toHaveLength(1);

    const removed = await w.call(session(['reach_settings:update']), 'DELETE', `/v1/reach/suppressions/${entry?.id}`);
    expect(removed.status).toBe(204);
    expect(await db.select().from(reachSuppressions)).toHaveLength(0);
  });

  it('refuses the suppression delete to a member whose update is denied, even an owner', async () => {
    const w = world();
    await w.call(session(OWNER), 'POST', '/v1/reach/suppressions', { values: ['blocked@acme.nl'] });
    const [entry] = await db.select().from(reachSuppressions);
    expect((await w.call(session(OWNER, ['reach_settings:update']), 'DELETE', `/v1/reach/suppressions/${entry?.id}`)).status).toBe(403);
    expect(await db.select().from(reachSuppressions)).toHaveLength(1);
  });

  it('removes a prospect from a campaign with reach_campaigns:update, not with delete', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' } });
    const prospect = await seedProspect(db);
    const enrollment = await seedEnrollment(db, campaign.id, prospect.id, { status: 'queued', nextSendAt: null });
    const w = world();
    const path = `/v1/reach/campaigns/${campaign.id}/enrollments/${enrollment.id}`;
    expect((await w.call(session(['reach_campaigns:delete']), 'DELETE', path)).status).toBe(403);
    expect((await w.call(session(['reach_campaigns:update']), 'DELETE', path)).status).toBe(204);
  });
});

describe('launching, through the tool', () => {
  it('launches a campaign with update, wakes the send sweep for the Clerk org and publishes the event', async () => {
    await seedSettings(db);
    const mailbox = await seedMailbox(db);
    const prospect = await seedProspect(db);
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' }, mailboxIds: [mailbox.id] });
    await seedEnrollment(db, campaign.id, prospect.id, { status: 'queued', nextSendAt: null });
    const w = world();

    // Create-only is not enough to start real email.
    const refused = await w.tool(session(['reach_campaigns:create']), 'launch_reach_campaign', { campaignId: campaign.id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Missing required permission for: reach_campaigns:update');
    expect(await w.dueRow()).toBeNull();

    const launched = await w.tool(session(['reach_campaigns:update']), 'launch_reach_campaign', { campaignId: campaign.id });
    expect(launched.isError).toBe(false);
    expect(launched.text).toContain('active');
    // The due index is keyed by the Clerk org id, which the session carries, not by the workspace id.
    expect(await w.dueRow()).toEqual({ workspaceId: ORG_ID });
    expect(w.events.filter((e) => e.entityType === 'reach_campaign' && e.action === 'launched')).toHaveLength(1);
  });

  it('tells the agent why a launch was refused, not only that it was', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' }, steps: [] });
    const result = await world().tool(session(OWNER), 'launch_reach_campaign', { campaignId: campaign.id });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('cannot be launched yet');
    expect(result.text).toContain('no_steps');
    expect(result.text).toContain('no_prospects');
  });

  it('never launches a campaign it only matched by name', async () => {
    await seedSettings(db);
    const mailbox = await seedMailbox(db);
    const prospect = await seedProspect(db);
    const { campaign } = await seedCampaign(db, { campaign: { name: 'Q4 logistics', status: 'draft' }, mailboxIds: [mailbox.id] });
    await seedEnrollment(db, campaign.id, prospect.id, { status: 'queued', nextSendAt: null });
    const w = world();

    const byName = await w.tool(session(OWNER), 'launch_reach_campaign', { campaignId: 'Q4 logistics' });
    expect(byName.isError).toBe(true);
    expect(byName.text).toContain('NOT_FOUND');
    expect(await w.dueRow()).toBeNull();
    expect(w.events.filter((e) => e.action === 'launched')).toHaveLength(0);

    // A read may still find it by name, as on every other tool.
    const read = await w.tool(session(OWNER), 'get_reach_campaign', { campaignId: 'Q4 logistics' });
    expect(read.isError).toBe(false);
    expect(read.text).toContain('Q4 logistics');
  });
});

describe('over the MCP protocol', () => {
  const REACH_MEMBER = ['reach_campaigns:read', 'reach_campaigns:update', 'reach_prospects:read', 'reach_prospects:create', 'reach_inbox:read'];

  it('offers each member the reach tools their permissions allow, with a JSON schema for every one', async () => {
    const w = world();
    const everything = await (await w.client(session(['reach_campaigns:*', 'reach_prospects:*', 'reach_settings:*', 'reach_inbox:*', 'reach_mailboxes:*']))).listTools();
    expect(everything.tools.map((t) => t.name).sort((a, b) => a.localeCompare(b))).toEqual(reachTools.map((t) => t.name).sort((a, b) => a.localeCompare(b)));
    for (const t of everything.tools) expect(t.inputSchema.type, t.name).toBe('object');
    const launch = everything.tools.find((t) => t.name === 'launch_reach_campaign');
    expect(launch?.inputSchema.required).toEqual(['campaignId']);

    const member = await (await w.client(session(REACH_MEMBER))).listTools();
    const names = member.tools.map((t) => t.name);
    expect(names).toContain('launch_reach_campaign');
    expect(names).toContain('create_reach_prospect');
    expect(names).toContain('list_reach_threads');
    expect(names).not.toContain('search_reach_mailboxes');
    expect(names).not.toContain('add_reach_suppressions');

    expect((await (await w.client(session(['leads:read']))).listTools()).tools.filter((t) => t.name.includes('reach'))).toEqual([]);
  });

  it('describes the tools that start email as doing so, and offers no way to reply', async () => {
    const { tools } = await (await world().client(session(OWNER_REACH))).listTools();
    const text = (name: string) => tools.find((t) => t.name === name)?.description ?? '';
    expect(text('launch_reach_campaign')).toContain('REAL EMAIL');
    expect(text('get_reach_access')).toContain('APP_ACCESS_REQUIRED');
    expect(tools.map((t) => t.name).filter((n) => /reply|send|forward/.test(n))).toEqual([]);
  });

  it('runs a tool call end to end: gate, permission, domain code, entity event', async () => {
    stubDns();
    const w = world();
    const client = await w.client(session(REACH_MEMBER));
    const created = await client.callTool({ name: 'create_reach_prospect', arguments: { email: 'Sam@Acme.nl', firstName: 'Sam' } });
    expect(created.isError).toBeFalsy();
    expect((created.content as Array<{ text: string }>)[0]?.text).toContain('sam@acme.nl');
    expect(w.events.filter((e) => e.entityType === 'reach_prospect' && e.action === 'created')).toHaveLength(1);

    const found = await client.callTool({ name: 'search_reach_prospects', arguments: { search: 'acme' } });
    expect((found.content as Array<{ text: string }>)[0]?.text).toContain('sam@acme.nl');
  });

  it('turns a refused workspace into a tool error, not a crash', async () => {
    const w = world({ access: accessRow({ status: 'requested' }) });
    const result = await (await w.client(session(REACH_MEMBER))).callTool({ name: 'search_reach_campaigns', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('APP_ACCESS_REQUIRED');
  });
});

describe('what MCP does not do', () => {
  it('has no route to answer a reply, whatever the member may do', async () => {
    const w = world();
    const reply = await w.call(session(OWNER), 'POST', '/v1/reach/threads/thread_x/reply', { body: 'Thanks, Friday works.' });
    expect(reply.status).toBe(404);
    const patch = await w.call(session(OWNER), 'PATCH', '/v1/reach/threads/thread_x', { body: 'x' });
    expect(patch.status).toBe(404);
  });

  it('answers an unknown thread with 404 and reads an empty inbox', async () => {
    const w = world();
    expect((await w.call(session(['reach_inbox:read']), 'GET', '/v1/reach/threads/thread_x')).status).toBe(404);
    const list = await w.call(session(['reach_inbox:read']), 'GET', '/v1/reach/threads');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ data: [], meta: { unreadCount: 0 } });
  });

  it('does not expose the Mailpool ids of a domain or mailbox, and does not open master for an empty list', async () => {
    const w = world();
    const mailboxes = await w.call(session(['reach_mailboxes:read']), 'GET', '/v1/reach/mailboxes');
    expect(mailboxes).toMatchObject({ status: 200, body: { data: [] } });
    const domains = await w.call(session(['reach_mailboxes:read']), 'GET', '/v1/reach/domains');
    expect(domains).toMatchObject({ status: 200, body: { data: [] } });
  });
});
