/**
 * WeldReach on MCP: what is registered, and what each tool needs.
 *
 * Three promises are pinned here:
 *
 *   1. Every mounted reach route has exactly one tool, and every tool points at
 *      a mounted route, so the two cannot drift apart.
 *   2. A tool needs exactly the permission the app (reach-api) asks for the same
 *      action. MCP derives a permission from the HTTP verb, which is wrong for
 *      WeldReach's action routes and for `reach_settings`, so those routes pin
 *      their own (`ROUTE_PERMISSIONS` in `lib/permissions.ts`).
 *   3. The inbox is read only: nothing here can answer a reply. (`mail.test.ts`
 *      checks the same thing for every tool of every module.)
 */

import { describe, expect, it } from 'vitest';
import { getAllPermissionKeys } from '@weldsuite/permissions/catalog';
import { reachTools } from './index';
import { allTools } from '../registry';
import { canPerform, canUseScope, routePermission } from '../../lib/permissions';

/**
 * The permission reach-api's `requirePermission(...)` asks for each route
 * (`apps/workers/reach-api/src/routes/*`), keyed like `ROUTE_PERMISSIONS`. This is
 * the table the MCP mapping has to reproduce; it is written out here, not derived,
 * so changing the mapping cannot quietly change what the test expects.
 */
const APP_PERMISSION: Record<string, string> = {
  'GET /v1/reach/access': 'reach_campaigns:read',
  'GET /v1/reach/overview': 'reach_campaigns:read',

  'GET /v1/reach/campaigns': 'reach_campaigns:read',
  'POST /v1/reach/campaigns': 'reach_campaigns:create',
  'GET /v1/reach/campaigns/:id': 'reach_campaigns:read',
  'PATCH /v1/reach/campaigns/:id': 'reach_campaigns:update',
  'DELETE /v1/reach/campaigns/:id': 'reach_campaigns:delete',
  'PUT /v1/reach/campaigns/:id/steps': 'reach_campaigns:update',
  'PUT /v1/reach/campaigns/:id/mailboxes': 'reach_campaigns:update',
  'POST /v1/reach/campaigns/:id/prospects': 'reach_campaigns:update',
  'GET /v1/reach/campaigns/:id/enrollments': 'reach_campaigns:read',
  'DELETE /v1/reach/campaigns/:id/enrollments/:enrollmentId': 'reach_campaigns:update',
  'POST /v1/reach/campaigns/:id/launch': 'reach_campaigns:update',
  'POST /v1/reach/campaigns/:id/pause': 'reach_campaigns:update',
  'POST /v1/reach/campaigns/:id/resume': 'reach_campaigns:update',
  'GET /v1/reach/campaigns/:id/stats': 'reach_campaigns:read',

  'GET /v1/reach/prospects': 'reach_prospects:read',
  'POST /v1/reach/prospects': 'reach_prospects:create',
  'POST /v1/reach/prospects/import': 'reach_prospects:create',
  'GET /v1/reach/prospects/:id': 'reach_prospects:read',
  'PATCH /v1/reach/prospects/:id': 'reach_prospects:update',
  'DELETE /v1/reach/prospects/:id': 'reach_prospects:delete',

  'GET /v1/reach/lists': 'reach_prospects:read',
  'POST /v1/reach/lists': 'reach_prospects:create',
  'GET /v1/reach/lists/:id': 'reach_prospects:read',
  'PATCH /v1/reach/lists/:id': 'reach_prospects:update',
  'DELETE /v1/reach/lists/:id': 'reach_prospects:delete',
  'POST /v1/reach/lists/:id/members': 'reach_prospects:update',
  'POST /v1/reach/lists/:id/members/remove': 'reach_prospects:update',

  'GET /v1/reach/suppressions': 'reach_settings:read',
  'POST /v1/reach/suppressions': 'reach_settings:update',
  'DELETE /v1/reach/suppressions/:id': 'reach_settings:update',

  'GET /v1/reach/threads': 'reach_inbox:read',
  'GET /v1/reach/threads/:threadKey': 'reach_inbox:read',

  'GET /v1/reach/mailboxes': 'reach_mailboxes:read',
  'GET /v1/reach/mailboxes/:id': 'reach_mailboxes:read',
  'GET /v1/reach/domains': 'reach_mailboxes:read',
  'GET /v1/reach/domains/:id': 'reach_mailboxes:read',
};

/** The reach routes the worker mounts, as `METHOD /v1/reach/...` (the router lists a route once per handler). */
async function mountedReachRoutes(): Promise<string[]> {
  const { v1 } = await import('../../api/routes/v1');
  const keys = v1.routes
    .filter((r) => r.method !== 'ALL' && r.path.startsWith('/reach/'))
    .map((r) => `${r.method} /v1${r.path}`);
  return [...new Set(keys)].sort((a, b) => a.localeCompare(b));
}

/** The route scope a request would carry: the permission's object, `read` for a GET, `write` otherwise (what the route files declare). */
function scopeOf(method: string, permission: string): string {
  return `${permission.split(':')[0]}:${method === 'GET' ? 'read' : 'write'}`;
}

const REACH_PERMISSIONS = getAllPermissionKeys().filter((key) => key.startsWith('reach_'));

describe('reach tools and routes', () => {
  it('every mounted reach route has exactly one tool, and every tool has a mounted route', async () => {
    const routes = await mountedReachRoutes();
    const tools = reachTools.map((t) => `${t.method} ${t.path}`).sort((a, b) => a.localeCompare(b));
    expect(tools).toEqual(routes);
    expect(new Set(tools).size).toBe(tools.length);
  });

  it('every tool name is unique across the whole server', () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(reachTools.map((t) => t.name).every((name) => /^[a-z]+(_[a-z]+)+$/.test(name))).toBe(true);
  });

  it('is part of allTools', () => {
    for (const tool of reachTools) expect(allTools).toContain(tool);
  });

  it('every path placeholder is filled from an input the tool declares', () => {
    for (const tool of reachTools) {
      const placeholders = [...tool.path.matchAll(/:(\w+)/g)].map((m) => m[1] as string);
      expect(Object.keys(tool.pathParams ?? {}).sort((a, b) => a.localeCompare(b)), tool.name).toEqual(
        [...placeholders].sort((a, b) => a.localeCompare(b)),
      );
      for (const field of Object.values(tool.pathParams ?? {})) {
        expect(Object.keys(tool.inputSchema), `${tool.name} → ${field}`).toContain(field);
      }
    }
  });

  it('every tool states what it is, and says so when it starts real email', () => {
    for (const tool of reachTools) expect(tool.description.length, tool.name).toBeGreaterThan(30);
    for (const name of ['launch_reach_campaign', 'resume_reach_campaign']) {
      const tool = reachTools.find((t) => t.name === name);
      expect(tool?.description, name).toMatch(/REAL EMAIL/);
    }
    expect(reachTools.find((t) => t.name === 'get_reach_access')?.description).toMatch(/APP_ACCESS_REQUIRED/);
    expect(reachTools.find((t) => t.name === 'list_reach_threads')?.description).toMatch(/cannot be sent from here/);
  });

  it('a tool that changes a record by id takes the id only, never a guessed name', () => {
    for (const tool of reachTools) {
      const hasId = Object.keys(tool.pathParams ?? {}).length > 0;
      if (tool.method !== 'GET' && hasId) expect(tool.exactId, tool.name).toBe(true);
    }
  });
});

describe('reach never sends', () => {
  it('has no tool for a reply, a send or a forward, and the inbox tools only read', () => {
    for (const tool of reachTools) {
      expect(tool.path, tool.name).not.toMatch(/\/(send|reply|forward)$/);
      expect(tool.name, tool.name).not.toMatch(/reply|send|forward/);
      expect(tool.scope, tool.name).not.toMatch(/:(send|reply)$/);
    }
    for (const tool of reachTools.filter((t) => t.path.startsWith('/v1/reach/threads'))) {
      expect(tool.method).toBe('GET');
      expect(tool.scope).toBe('reach_inbox:read');
    }
  });

  it('does not mount the reply route', async () => {
    const { v1 } = await import('../../api/routes/v1');
    const reply = v1.routes.filter((r) => /\/threads\/.*\/reply$/.test(r.path) || (r.path.startsWith('/reach/threads') && r.method !== 'GET' && r.method !== 'ALL'));
    expect(reply.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it('a key with reach_inbox:reply is worth nothing here: no route asks for it', () => {
    expect(Object.values(APP_PERMISSION)).not.toContain('reach_inbox:reply');
    expect(canPerform(['reach_inbox:reply'], 'reach_inbox:read', 'GET', '/v1/reach/threads')).toBe(false);
  });
});

describe('every reach route needs exactly the permission the app asks for', () => {
  it('knows every mounted route, and only those', async () => {
    expect(await mountedReachRoutes()).toEqual(Object.keys(APP_PERMISSION).sort((a, b) => a.localeCompare(b)));
  });

  it('grants a route to the one permission the app asks for, and to no other WeldReach permission', async () => {
    expect(REACH_PERMISSIONS.length).toBeGreaterThan(10);
    const wrong: string[] = [];
    for (const [key, required] of Object.entries(APP_PERMISSION)) {
      const [method, route] = key.split(' ') as [string, string];
      const scope = scopeOf(method, required);
      for (const held of REACH_PERMISSIONS) {
        const allowed = canPerform([held], scope, method, route);
        if (allowed !== (held === required)) wrong.push(`${key} with ${held}: ${allowed ? 'allowed' : 'denied'}, the app asks for ${required}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('opens every route to a workspace owner and to the object wildcard, and to nobody without a grant', () => {
    for (const [key, required] of Object.entries(APP_PERMISSION)) {
      const [method, route] = key.split(' ') as [string, string];
      const scope = scopeOf(method, required);
      expect(canPerform(['*'], scope, method, route), `${key} with *`).toBe(true);
      expect(canPerform([`${required.split(':')[0]}:*`], scope, method, route), `${key} with the object wildcard`).toBe(true);
      expect(canPerform([], scope, method, route), `${key} with nothing`).toBe(false);
      expect(canPerform({ permissions: ['*'], denies: [required] }, scope, method, route), `${key} with a member deny`).toBe(false);
    }
  });

  it('pins a route only where the HTTP verb gets it wrong', () => {
    for (const [key, required] of Object.entries(APP_PERMISSION)) {
      const [method, route] = key.split(' ') as [string, string];
      const scope = scopeOf(method, required);
      // What the verb alone would have allowed, with no route given: one permission, and a deny on it still binds an owner.
      const byVerb = REACH_PERMISSIONS.filter((held) => canPerform([held], scope, method));
      const denyHolds = !canPerform({ permissions: ['*'], denies: [required] }, scope, method);
      const verbIsRight = byVerb.length === 1 && byVerb[0] === required && denyHolds;
      const pinned = routePermission(method, route);
      if (pinned) {
        expect(pinned, key).toBe(required);
        expect(verbIsRight, `${key} is pinned but the verb already gets it right`).toBe(false);
      } else {
        expect(verbIsRight, `${key} needs a pin: the verb allows ${byVerb.join(', ')}, a deny holds: ${denyHolds}`).toBe(true);
      }
    }
  });

  it('the cases that matter, spelled out', () => {
    // Launching starts real email: a create-only grant must not do it, an update grant must.
    expect(canPerform(['reach_campaigns:create'], 'reach_campaigns:write', 'POST', '/v1/reach/campaigns/:id/launch')).toBe(false);
    expect(canPerform(['reach_campaigns:update'], 'reach_campaigns:write', 'POST', '/v1/reach/campaigns/:id/launch')).toBe(true);
    // Creating a campaign is create, not update.
    expect(canPerform(['reach_campaigns:update'], 'reach_campaigns:write', 'POST', '/v1/reach/campaigns')).toBe(false);
    expect(canPerform(['reach_campaigns:create'], 'reach_campaigns:write', 'POST', '/v1/reach/campaigns')).toBe(true);
    // Taking a prospect out of a campaign is an update, not a delete.
    const enrollment = '/v1/reach/campaigns/:id/enrollments/:enrollmentId';
    expect(canPerform(['reach_campaigns:update'], 'reach_campaigns:write', 'DELETE', enrollment)).toBe(true);
    expect(canPerform(['reach_campaigns:delete'], 'reach_campaigns:write', 'DELETE', enrollment)).toBe(false);
    // Deleting the campaign itself is still delete.
    expect(canPerform(['reach_campaigns:delete'], 'reach_campaigns:write', 'DELETE', '/v1/reach/campaigns/:id')).toBe(true);
    expect(canPerform(['reach_campaigns:update'], 'reach_campaigns:write', 'DELETE', '/v1/reach/campaigns/:id')).toBe(false);
    // reach_settings has read and update only: removing a suppression must be reachable with update.
    expect(canPerform(['reach_settings:update'], 'reach_settings:write', 'DELETE', '/v1/reach/suppressions/:id')).toBe(true);
    expect(canPerform(['reach_settings:read'], 'reach_settings:write', 'DELETE', '/v1/reach/suppressions/:id')).toBe(false);
    // Prospects: importing creates, adding to a list updates.
    expect(canPerform(['reach_prospects:update'], 'reach_prospects:write', 'POST', '/v1/reach/prospects/import')).toBe(false);
    expect(canPerform(['reach_prospects:create'], 'reach_prospects:write', 'POST', '/v1/reach/lists/:id/members')).toBe(false);
    // The pin follows the registered route, not the id in the URL, and does not touch other modules.
    expect(routePermission('POST', '/v1/reach/campaigns/:id/launch')).toBe('reach_campaigns:update');
    expect(routePermission('POST', undefined)).toBeUndefined();
    expect(routePermission('POST', '/v1/leads/:id/launch')).toBeUndefined();
    expect(canPerform(['leads:create'], 'leads:write', 'POST', '/v1/leads')).toBe(true);
  });
});

describe('which reach tools a member is offered', () => {
  const offered = (permissions: string[]) => reachTools.filter((t) => canUseScope(permissions, t.scope)).map((t) => t.name);

  it('offers a read-only member the reads of what they may read, and no writes', () => {
    const names = offered(['reach_campaigns:read', 'reach_inbox:read']);
    expect(names).toContain('search_reach_campaigns');
    expect(names).toContain('list_reach_threads');
    expect(names).not.toContain('launch_reach_campaign');
    expect(names).not.toContain('search_reach_prospects');
    expect(names).not.toContain('search_reach_mailboxes');
  });

  it('offers nothing to a member with no WeldReach permission', () => {
    expect(offered(['leads:read', 'tickets:update'])).toEqual([]);
  });

  it('offers every tool to an owner', () => {
    expect(offered(['*'])).toHaveLength(reachTools.length);
  });
});
