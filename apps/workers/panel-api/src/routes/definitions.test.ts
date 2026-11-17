/**
 * DB-backed tests (pglite) for the data definitions: custom events, computed
 * properties and path rules.
 *
 * What must not regress:
 *   1. A custom event never includes another custom event, names a computed
 *      property only when it exists in the project, and its name is unique in
 *      the project; specs refer to it as `@<id>`.
 *   2. A formula is checked with the shared expression parser (the position of
 *      the problem comes back); coalesce takes 2-5 inputs.
 *   3. Path rules: valid JavaScript regexes without lookarounds or
 *      backreferences, ≤ 500 characters, ≤ 30 rules; replacing keeps ids by
 *      position and publishes created / updated / deleted per rule; the test
 *      route applies rules in order like the query engine.
 *   4. Definitions never put their definition on the entity bus, and every
 *      write needs its permission.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import {
  applyPanelPathRules,
  panelPathPatternProblem,
  type PanelComputedPropertyDto,
  type PanelCustomEventDto,
  type PanelPathRuleDto,
  type PanelPathRuleTestResult,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { Env, Variables } from '../types';
import customEventsRoutes from './custom-events';
import computedPropertiesRoutes from './computed-properties';
import pathRulesRoutes from './path-rules';

const { panelProjects, panelCustomEvents, panelComputedProperties, panelPathRules } = schema;

const MEMBER = ['panel_reports:read', 'panel_reports:create', 'panel_reports:update', 'panel_reports:delete'];
const READER = ['panel_reports:read'];

let db: Database;
let events: EntityEventMessage[] = [];
const queue = {
  send: async (message: EntityEventMessage) => {
    events.push(message);
  },
} as unknown as Queue<EntityEventMessage>;

type Router = Hono<{ Bindings: Env; Variables: Variables }>;

function app(base: string, router: Router, grants: string[] = MEMBER) {
  return createTestApp(base, router, {
    context: { permissions: permissions(...grants), tenantDb: db, userId: 'user_alice', orgId: 'org_alpha', workspaceId: 'ws_alpha', clerkOrgId: 'org_alpha' },
    env: { ENTITY_EVENTS: queue, PANEL_COLLECTOR_URL: 'https://pnl-test.weldsuite.org' },
  });
}

const customEvents = (grants?: string[]) => app('/api/panel/custom-events', customEventsRoutes, grants);
const computed = (grants?: string[]) => app('/api/panel/computed-properties', computedPropertiesRoutes, grants);
const pathRules = (grants?: string[]) => app('/api/panel/path-rules', pathRulesRoutes, grants);

const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

beforeEach(async () => {
  for (const table of [panelCustomEvents, panelComputedProperties, panelPathRules, panelProjects]) await db.delete(table);
  events = [];
  for (const id of ['pnp_a', 'pnp_b']) {
    await db.insert(panelProjects).values({ id, name: id, token: `wpk_${id}`, settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' });
  }
});

// ---------------------------------------------------------------------------
// Custom events
// ---------------------------------------------------------------------------

describe('custom events', () => {
  const definition = {
    match: [
      { event: 'Signed up', filters: [{ source: 'event', key: 'plan', operator: 'eq', value: 'pro' }] },
      { event: '$pageview', filters: [{ source: 'column', field: 'path', operator: 'eq', value: '/welcome' }] },
    ],
  };

  it('creates, lists, renames and deletes, with a `@id` ref and events without the definition', async () => {
    const api = customEvents();
    const res = await api.request('/api/panel/custom-events', json({ projectId: 'pnp_a', name: 'Activated', definition }));
    expect(res.status).toBe(201);
    const created = await data<PanelCustomEventDto>(res);
    expect(created.id).toMatch(/^pnce_/);
    expect(created.ref).toBe(`@${created.id}`);
    expect(created.definition.match).toHaveLength(2);

    expect(await data<PanelCustomEventDto[]>(await api.request('/api/panel/custom-events?projectId=pnp_a'))).toHaveLength(1);
    expect(await data<PanelCustomEventDto[]>(await api.request('/api/panel/custom-events?projectId=pnp_b'))).toHaveLength(0);
    const renamed = await api.request(`/api/panel/custom-events/${created.id}`, json({ name: 'Activated user' }, 'PATCH'));
    expect(await data<PanelCustomEventDto>(renamed)).toMatchObject({ name: 'Activated user' });
    expect((await api.request(`/api/panel/custom-events/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api.request(`/api/panel/custom-events/${created.id}`)).status).toBe(404);

    expect(events.map((e) => [e.entityType, e.action])).toEqual([
      ['panel_custom_event', 'created'],
      ['panel_custom_event', 'updated'],
      ['panel_custom_event', 'deleted'],
    ]);
    expect(JSON.stringify(events)).not.toContain('/welcome');
  });

  it('refuses a nested custom event, an unknown computed property, a taken name and an unknown project', async () => {
    const api = customEvents();
    const nested = { match: [{ event: '@pnce_abc123', filters: [] }] };
    expect((await api.request('/api/panel/custom-events', json({ projectId: 'pnp_a', name: 'N', definition: nested }))).status).toBe(400);
    expect((await api.request('/api/panel/custom-events', json({ projectId: 'pnp_a', name: 'N', definition: { match: [] } }))).status).toBe(400);
    const unknownRef = { match: [{ event: 'Paid', filters: [{ source: 'event', key: '@pncp_missing', operator: 'gt', value: 10 }] }] };
    expect((await api.request('/api/panel/custom-events', json({ projectId: 'pnp_a', name: 'N', definition: unknownRef }))).status).toBe(400);

    expect((await api.request('/api/panel/custom-events', json({ projectId: 'pnp_a', name: 'Activated', definition }))).status).toBe(201);
    expect((await api.request('/api/panel/custom-events', json({ projectId: 'pnp_a', name: 'activated', definition }))).status).toBe(409);
    // The same name in another project is fine.
    expect((await api.request('/api/panel/custom-events', json({ projectId: 'pnp_b', name: 'Activated', definition }))).status).toBe(201);
    expect((await api.request('/api/panel/custom-events', json({ projectId: 'pnp_x', name: 'X', definition }))).status).toBe(404);
  });

  it('accepts a computed property of the project in its filters', async () => {
    const prop = await data<PanelComputedPropertyDto>(
      await computed().request('/api/panel/computed-properties', json({ projectId: 'pnp_a', name: 'Revenue', definition: { kind: 'formula', expression: 'price * quantity' } })),
    );
    const withRef = { match: [{ event: 'Paid', filters: [{ source: 'event', key: prop.ref, operator: 'gt', value: 100 }] }] };
    expect((await customEvents().request('/api/panel/custom-events', json({ projectId: 'pnp_a', name: 'Big order', definition: withRef }))).status).toBe(201);
    // Not one of another project.
    expect((await customEvents().request('/api/panel/custom-events', json({ projectId: 'pnp_b', name: 'Big order', definition: withRef }))).status).toBe(400);
  });

  it('needs the permission to write', async () => {
    expect((await customEvents(READER).request('/api/panel/custom-events', json({ projectId: 'pnp_a', name: 'A', definition }))).status).toBe(403);
    expect((await customEvents(READER).request('/api/panel/custom-events?projectId=pnp_a')).status).toBe(200);
    expect((await customEvents([]).request('/api/panel/custom-events?projectId=pnp_a')).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Computed properties
// ---------------------------------------------------------------------------

describe('computed properties', () => {
  it('checks formulas with the shared parser and says where the problem is', async () => {
    const api = computed();
    const ok = await api.request('/api/panel/computed-properties', json({ projectId: 'pnp_a', name: 'Revenue', definition: { kind: 'formula', expression: '(price - discount) × quantity' } }));
    expect(ok.status).toBe(201);
    expect((await data<PanelComputedPropertyDto>(ok)).ref).toMatch(/^@pncp_/);

    const bad = await api.request('/api/panel/computed-properties', json({ projectId: 'pnp_a', name: 'Bad', definition: { kind: 'formula', expression: 'price * (quantity' } }));
    expect(bad.status).toBe(400);
    const error = ((await bad.json()) as { error: { message: string; details?: { position: number } } }).error;
    expect(error.message).toMatch(/parenthesis/i);
    expect(typeof error.details?.position).toBe('number');

    expect((await api.request('/api/panel/computed-properties', json({ projectId: 'pnp_a', name: 'Const', definition: { kind: 'formula', expression: '2 * 3' } }))).status).toBe(400);
    expect((await api.request('/api/panel/computed-properties', json({ projectId: 'pnp_a', name: 'Eval', definition: { kind: 'formula', expression: 'alert(1)' } }))).status).toBe(400);
    expect(JSON.stringify(events)).not.toContain('price');
  });

  it('takes 2-5 coalesce inputs, keeps names unique and changes the definition', async () => {
    const api = computed();
    const coalesce = { kind: 'coalesce', keys: [{ source: 'event', key: 'utm_source' }, { source: 'column', field: 'referrer_host' }] };
    const created = await data<PanelComputedPropertyDto>(await api.request('/api/panel/computed-properties', json({ projectId: 'pnp_a', name: 'Source', definition: coalesce })));
    expect(created.definition).toEqual(coalesce);
    expect((await api.request('/api/panel/computed-properties', json({ projectId: 'pnp_a', name: 'One', definition: { kind: 'coalesce', keys: [{ source: 'event', key: 'a' }] } }))).status).toBe(400);
    expect((await api.request('/api/panel/computed-properties', json({ projectId: 'pnp_a', name: 'SOURCE', definition: coalesce }))).status).toBe(409);

    const changed = await api.request(`/api/panel/computed-properties/${created.id}`, json({ definition: { kind: 'formula', expression: '$lcp / 1000' } }, 'PATCH'));
    expect(await data<PanelComputedPropertyDto>(changed)).toMatchObject({ definition: { kind: 'formula', expression: '$lcp / 1000' } });
    expect((await api.request(`/api/panel/computed-properties/${created.id}`, json({ definition: { kind: 'formula', expression: '/' } }, 'PATCH'))).status).toBe(400);
    expect((await api.request(`/api/panel/computed-properties/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(events.map((e) => [e.entityType, e.action])).toEqual([
      ['panel_computed_property', 'created'],
      ['panel_computed_property', 'updated'],
      ['panel_computed_property', 'deleted'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Path rules
// ---------------------------------------------------------------------------

describe('path rules', () => {
  const rules = [
    { pattern: '^/users/\\d+', replacement: '/users/:id', description: 'User pages' },
    { pattern: '/[0-9a-f]{8}-[0-9a-f-]{27}', replacement: '/:uuid' },
  ];

  it('replaces the list in order, keeping ids by position, with one event per change', async () => {
    const api = pathRules();
    const first = await api.request('/api/panel/path-rules?projectId=pnp_a', json({ rules }, 'PUT'));
    expect(first.status).toBe(200);
    const saved = await data<PanelPathRuleDto[]>(first);
    expect(saved.map((r) => [r.position, r.pattern])).toEqual([
      [0, rules[0]?.pattern],
      [1, rules[1]?.pattern],
    ]);
    expect(events.map((e) => e.action)).toEqual(['created', 'created']);
    events = [];

    const second = await data<PanelPathRuleDto[]>(
      await api.request('/api/panel/path-rules?projectId=pnp_a', json({ rules: [{ ...rules[0], replacement: '/u/:id' }] }, 'PUT')),
    );
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ id: saved[0]?.id, replacement: '/u/:id', description: 'User pages' });
    expect(events.map((e) => [e.entityType, e.action, e.entityId])).toEqual([
      ['panel_path_rule', 'updated', saved[0]?.id],
      ['panel_path_rule', 'deleted', saved[1]?.id],
    ]);

    expect(await data<PanelPathRuleDto[]>(await api.request('/api/panel/path-rules?projectId=pnp_a'))).toHaveLength(1);
    expect(await data<PanelPathRuleDto[]>(await api.request('/api/panel/path-rules?projectId=pnp_b'))).toHaveLength(0);
    expect((await api.request('/api/panel/path-rules?projectId=pnp_a', json({ rules: [] }, 'PUT'))).status).toBe(200);
    expect(await db.select().from(panelPathRules)).toHaveLength(0);
  });

  it('refuses invalid, unsupported, too long and too many patterns, and unknown projects', async () => {
    const api = pathRules();
    const put = (body: unknown, project = 'pnp_a') => api.request(`/api/panel/path-rules?projectId=${project}`, json({ rules: body }, 'PUT'));
    expect((await put([{ pattern: '/users/(\\d+', replacement: 'x' }])).status).toBe(400);
    expect((await put([{ pattern: '/(?=admin)', replacement: 'x' }])).status).toBe(400);
    expect((await put([{ pattern: '/(\\w+)/\\1', replacement: 'x' }])).status).toBe(400);
    expect((await put([{ pattern: `/${'a'.repeat(500)}`, replacement: 'x' }])).status).toBe(400);
    expect((await put(Array.from({ length: 31 }, (_, i) => ({ pattern: `/p${i}`, replacement: '/p' })))).status).toBe(400);
    expect((await put(rules, 'pnp_x')).status).toBe(404);
    expect(events).toHaveLength(0);
  });

  it('needs create to add rules and delete to remove them on top of update', async () => {
    const onlyUpdate = pathRules(['panel_reports:read', 'panel_reports:update']);
    expect((await onlyUpdate.request('/api/panel/path-rules?projectId=pnp_a', json({ rules }, 'PUT'))).status).toBe(403);
    await pathRules().request('/api/panel/path-rules?projectId=pnp_a', json({ rules }, 'PUT'));
    expect((await onlyUpdate.request('/api/panel/path-rules?projectId=pnp_a', json({ rules: [rules[1], rules[0]] }, 'PUT'))).status).toBe(200);
    expect((await onlyUpdate.request('/api/panel/path-rules?projectId=pnp_a', json({ rules: [rules[0]] }, 'PUT'))).status).toBe(403);
    expect((await pathRules(READER).request('/api/panel/path-rules?projectId=pnp_a', json({ rules }, 'PUT'))).status).toBe(403);
  });

  it('previews rules on sample paths, given or saved, in order', async () => {
    const api = pathRules(READER);
    const res = await api.request(
      '/api/panel/path-rules/test',
      json({ rules: [...rules, { pattern: '^/users/:id$', replacement: '/people' }], paths: ['/users/42', '/docs/0f8fad5b-d9cb-469f-a165-70867728950e', '/about'] }),
    );
    const { results } = await data<{ results: PanelPathRuleTestResult[] }>(res);
    expect(results).toEqual([
      { path: '/users/42', cleaned: '/people', matched: [0, 2] },
      { path: '/docs/0f8fad5b-d9cb-469f-a165-70867728950e', cleaned: '/docs/:uuid', matched: [1] },
      { path: '/about', cleaned: '/about', matched: [] },
    ]);

    await pathRules().request('/api/panel/path-rules?projectId=pnp_a', json({ rules }, 'PUT'));
    const saved = await data<{ results: PanelPathRuleTestResult[] }>(await api.request('/api/panel/path-rules/test', json({ projectId: 'pnp_a', paths: ['/users/7/edit'] })));
    expect(saved.results[0]?.cleaned).toBe('/users/:id/edit');
    expect((await api.request('/api/panel/path-rules/test', json({ paths: ['/x'] }))).status).toBe(400);
  });

  it('validates patterns the same way on the client', () => {
    expect(panelPathPatternProblem('^/a/\\d+$')).toBeNull();
    expect(panelPathPatternProblem('(?<!x)y')).not.toBeNull();
    expect(applyPanelPathRules('/a/1/b/2', [{ pattern: '\\d+', replacement: 'N' }])).toEqual({ cleaned: '/a/N/b/N', matched: [0] });
  });
});
