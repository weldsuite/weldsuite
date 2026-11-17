/**
 * DB-backed tests (pglite) for annotations, comments, report versions and
 * metric trees.
 *
 * What must not regress:
 *   1. Annotations: project-wide ones show on every report, a report's own
 *      only with it; one on a report the caller may not see is a 404; only the
 *      author (or a manager) changes or deletes.
 *   2. Comments: only who may see the target reads or writes them; the
 *      target's owner gets one in-app notification (in their language) when
 *      someone else comments; the body never goes on the entity bus.
 *   3. Every report change to name, description or spec keeps the state
 *      before as a version; a restore puts a version back and keeps the
 *      current state as a version too; visibility-only changes keep none.
 *   4. Metric trees are trees (one root, no cycles, ≤ 25 nodes), their
 *      metrics are trends of the same project the caller may see, and they
 *      follow the report visibility rule.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import type { PanelReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type {
  PanelAnnotationDto,
  PanelCommentDto,
  PanelMetricTreeDto,
  PanelReportVersionDetailDto,
  PanelReportVersionDto,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { Env, Variables } from '../types';

const sent = vi.hoisted(() => ({ notifications: [] as Record<string, unknown>[] }));

vi.mock('@weldsuite/notifications', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/notifications')>();
  return {
    ...actual,
    createAndDeliverNotification: vi.fn(async (params: Record<string, unknown>) => {
      sent.notifications.push(params);
      return 'ntf_1';
    }),
  };
});

import reportsRoutes from './reports';
import annotationsRoutes from './annotations';
import commentsRoutes from './comments';
import metricTreesRoutes from './metric-trees';

const { panelProjects, panelReports, panelReportVersions, panelAnnotations, panelComments, panelMetricTrees, userPreferences } = schema;

const MEMBER = ['panel_reports:read', 'panel_reports:create', 'panel_reports:update', 'panel_reports:delete'];
const ADMIN = [...MEMBER, 'panel_projects:manage'];
const READER = ['panel_reports:read'];

let db: Database;
let events: EntityEventMessage[] = [];
const queue = {
  send: async (message: EntityEventMessage) => {
    events.push(message);
  },
} as unknown as Queue<EntityEventMessage>;

type Router = Hono<{ Bindings: Env; Variables: Variables }>;

function app(base: string, router: Router, userId: string, grants: string[] = MEMBER) {
  return createTestApp(base, router, {
    context: { permissions: permissions(...grants), tenantDb: db, userId, orgId: 'org_alpha', workspaceId: 'ws_alpha', clerkOrgId: 'org_alpha' },
    env: { ENTITY_EVENTS: queue, PANEL_COLLECTOR_URL: 'https://pnl-test.weldsuite.org', PLATFORM_URL: 'https://app-test.weldsuite.org' },
  });
}

const reports = (user: string, grants?: string[]) => app('/api/panel/reports', reportsRoutes, user, grants);
const annotations = (user: string, grants?: string[]) => app('/api/panel/annotations', annotationsRoutes, user, grants);
const comments = (user: string, grants?: string[]) => app('/api/panel/comments', commentsRoutes, user, grants);
const trees = (user: string, grants?: string[]) => app('/api/panel/metric-trees', metricTreesRoutes, user, grants);

const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

const TRENDS = (projectId: string, event = '$pageview') => ({
  kind: 'trends',
  projectId,
  dateRange: { preset: '30d' },
  series: [{ event, math: 'unique_users' }],
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

beforeEach(async () => {
  for (const table of [panelReportVersions, panelAnnotations, panelComments, panelMetricTrees, panelReports, panelProjects, userPreferences]) {
    await db.delete(table);
  }
  events = [];
  sent.notifications.length = 0;
  for (const id of ['pnp_a', 'pnp_b']) {
    await db.insert(panelProjects).values({ id, name: id, token: `wpk_${id}`, settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' });
  }
});

async function newReport(user: string, extra: Record<string, unknown> = {}, projectId = 'pnp_a') {
  const res = await reports(user).request('/api/panel/reports', json({ projectId, name: 'Weekly visitors', spec: TRENDS(projectId), ...extra }));
  expect(res.status).toBe(201);
  return data<PanelReportDto>(res);
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

describe('annotations', () => {
  it('lists project-wide ones everywhere and a report\'s own only with it, by date, with events that leave the description out', async () => {
    const report = await newReport('user_alice', { visibility: 'workspace' });
    const api = annotations('user_alice');
    const launch = await api.request('/api/panel/annotations', json({ projectId: 'pnp_a', occurredAt: '2026-11-01T09:00:00Z', label: 'Launch', description: 'secret plan' }));
    expect(launch.status).toBe(201);
    const onReport = await data<PanelAnnotationDto>(
      await api.request('/api/panel/annotations', json({ projectId: 'pnp_a', reportId: report.id, occurredAt: '2026-11-05T09:00:00Z', label: 'Price change' })),
    );
    expect(onReport.id).toMatch(/^pnan_/);
    await api.request('/api/panel/annotations', json({ projectId: 'pnp_a', occurredAt: '2026-10-01T09:00:00Z', label: 'Old' }));

    const projectWide = await data<PanelAnnotationDto[]>(await api.request('/api/panel/annotations?projectId=pnp_a&from=2026-10-15&to=2026-11-30'));
    expect(projectWide.map((a) => a.label)).toEqual(['Launch']);
    const withReport = await data<PanelAnnotationDto[]>(await api.request(`/api/panel/annotations?projectId=pnp_a&from=2026-10-15&reportId=${report.id}`));
    expect(withReport.map((a) => a.label)).toEqual(['Launch', 'Price change']);
    expect(await data<PanelAnnotationDto[]>(await api.request('/api/panel/annotations?projectId=pnp_b'))).toHaveLength(0);

    expect(events.filter((e) => e.entityType === 'panel_annotation').map((e) => e.action)).toEqual(['created', 'created', 'created']);
    expect(JSON.stringify(events)).not.toContain('secret plan');
  });

  it('keeps annotations on a private report to those who may see it', async () => {
    const priv = await newReport('user_alice');
    const note = await data<PanelAnnotationDto>(
      await annotations('user_alice').request('/api/panel/annotations', json({ projectId: 'pnp_a', reportId: priv.id, occurredAt: '2026-11-05T09:00:00Z', label: 'Mine' })),
    );
    const bob = annotations('user_bob');
    expect((await bob.request(`/api/panel/annotations/${note.id}`)).status).toBe(404);
    expect((await bob.request(`/api/panel/annotations?projectId=pnp_a&reportId=${priv.id}`)).status).toBe(404);
    expect((await bob.request('/api/panel/annotations', json({ projectId: 'pnp_a', reportId: priv.id, occurredAt: '2026-11-05T09:00:00Z', label: 'x' }))).status).toBe(404);
    // A report of another project is not this project's.
    const other = await newReport('user_alice', { visibility: 'workspace' }, 'pnp_b');
    expect((await annotations('user_alice').request('/api/panel/annotations', json({ projectId: 'pnp_a', reportId: other.id, occurredAt: '2026-11-05T09:00:00Z', label: 'x' }))).status).toBe(404);
    expect((await annotations('user_alice').request('/api/panel/annotations', json({ projectId: 'pnp_x', occurredAt: '2026-11-05T09:00:00Z', label: 'x' }))).status).toBe(404);
  });

  it('lets the author or a manager change and delete, and nobody without the permission write', async () => {
    const note = await data<PanelAnnotationDto>(
      await annotations('user_alice').request('/api/panel/annotations', json({ projectId: 'pnp_a', occurredAt: '2026-11-01T09:00:00Z', label: 'Launch' })),
    );
    expect((await annotations('user_bob').request(`/api/panel/annotations/${note.id}`, json({ label: 'Bob' }, 'PATCH'))).status).toBe(403);
    const renamed = await annotations('user_alice').request(`/api/panel/annotations/${note.id}`, json({ label: 'Big launch' }, 'PATCH'));
    expect(await data<PanelAnnotationDto>(renamed)).toMatchObject({ label: 'Big launch' });
    expect((await annotations('user_root', ADMIN).request(`/api/panel/annotations/${note.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await annotations('user_alice').request(`/api/panel/annotations/${note.id}`)).status).toBe(404);
    expect((await annotations('user_alice', READER).request('/api/panel/annotations', json({ projectId: 'pnp_a', occurredAt: '2026-11-01T09:00:00Z', label: 'x' }))).status).toBe(403);
    expect(events.filter((e) => e.entityType === 'panel_annotation').map((e) => e.action)).toEqual(['created', 'updated', 'deleted']);
  });
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

describe('comments', () => {
  it('tells the owner when someone else comments, in their language, and keeps the body off the bus', async () => {
    const report = await newReport('user_alice', { visibility: 'workspace' });
    await db.insert(userPreferences).values({ id: 'prf_alice', userId: 'user_alice', language: 'nl' });
    const bob = comments('user_bob');
    const res = await bob.request('/api/panel/comments', json({ targetType: 'report', targetId: report.id, body: 'Why did **visitors** drop?' }));
    expect(res.status).toBe(201);
    await bob.settled();
    const comment = await data<PanelCommentDto>(res);
    expect(comment).toMatchObject({ targetType: 'report', targetId: report.id, authorUserId: 'user_bob', projectId: 'pnp_a', edited: false });

    expect(sent.notifications).toHaveLength(1);
    expect(sent.notifications[0]).toMatchObject({
      userId: 'user_alice',
      workspaceId: 'org_alpha',
      title: 'Iemand reageerde op het rapport "Weekly visitors"',
      body: 'Why did visitors drop?',
      entityType: 'panel_comment',
      entityId: comment.id,
      actionUrl: `/weldpanel/insights?report=${report.id}`,
      excludeChannels: ['email', 'push'],
    });
    expect(events.find((e) => e.entityType === 'panel_comment')).toMatchObject({ action: 'created', entityId: comment.id });
    expect(JSON.stringify(events)).not.toContain('drop?');

    // The owner's own comment notifies nobody.
    const own = comments('user_alice');
    await own.request('/api/panel/comments', json({ targetType: 'report', targetId: report.id, body: 'Looking into it' }));
    await own.settled();
    expect(sent.notifications).toHaveLength(1);

    const listed = await data<PanelCommentDto[]>(await bob.request(`/api/panel/comments?targetType=report&targetId=${report.id}`));
    expect(listed.map((c) => c.authorUserId)).toEqual(['user_bob', 'user_alice']);
  });

  it('keeps comments on a private target to its owner', async () => {
    const priv = await newReport('user_alice');
    await comments('user_alice').request('/api/panel/comments', json({ targetType: 'report', targetId: priv.id, body: 'note to self' }));
    const bob = comments('user_bob');
    expect((await bob.request(`/api/panel/comments?targetType=report&targetId=${priv.id}`)).status).toBe(404);
    expect((await bob.request('/api/panel/comments', json({ targetType: 'report', targetId: priv.id, body: 'hi' }))).status).toBe(404);
    expect((await bob.request('/api/panel/comments', json({ targetType: 'dashboard', targetId: 'pnd_nope', body: 'hi' }))).status).toBe(404);
    expect((await bob.request('/api/panel/comments', json({ targetType: 'report', targetId: priv.id, body: '' }))).status).toBe(400);
  });

  it('lets only the author edit, and the author or a manager delete', async () => {
    const report = await newReport('user_alice', { visibility: 'workspace' });
    const comment = await data<PanelCommentDto>(
      await comments('user_bob').request('/api/panel/comments', json({ targetType: 'report', targetId: report.id, body: 'First' })),
    );
    expect((await comments('user_alice', ADMIN).request(`/api/panel/comments/${comment.id}`, json({ body: 'Edited by admin' }, 'PATCH'))).status).toBe(403);
    const edited = await comments('user_bob').request(`/api/panel/comments/${comment.id}`, json({ body: 'First, edited' }, 'PATCH'));
    expect(await data<PanelCommentDto>(edited)).toMatchObject({ body: 'First, edited' });
    expect((await comments('user_carol').request(`/api/panel/comments/${comment.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await comments('user_root', ADMIN).request(`/api/panel/comments/${comment.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await data<PanelCommentDto[]>(await comments('user_bob').request(`/api/panel/comments?targetType=report&targetId=${report.id}`))).toHaveLength(0);
    expect(events.filter((e) => e.entityType === 'panel_comment').map((e) => e.action)).toEqual(['created', 'updated', 'deleted']);
  });
});

// ---------------------------------------------------------------------------
// Report versions
// ---------------------------------------------------------------------------

describe('report versions', () => {
  it('keeps the state before every content change, not for visibility or unchanged values', async () => {
    const report = await newReport('user_alice');
    const api = reports('user_alice');
    await api.request(`/api/panel/reports/${report.id}`, json({ name: 'Renamed' }, 'PATCH'));
    await api.request(`/api/panel/reports/${report.id}`, json({ spec: TRENDS('pnp_a', 'Signed up') }, 'PATCH'));
    await api.request(`/api/panel/reports/${report.id}`, json({ visibility: 'workspace' }, 'PATCH'));
    await api.request(`/api/panel/reports/${report.id}`, json({ name: 'Renamed' }, 'PATCH'));
    await api.request(`/api/panel/reports/${report.id}`, json({ spec: TRENDS('pnp_a', 'Signed up') }, 'PATCH'));

    const versions = await data<PanelReportVersionDto[]>(await api.request(`/api/panel/reports/${report.id}/versions`));
    expect(versions.map((v) => [v.version, v.name])).toEqual([
      [2, 'Renamed'],
      [1, 'Weekly visitors'],
    ]);
    expect(versions[0]).toMatchObject({ kind: 'trends', createdByUserId: 'user_alice' });
    expect('spec' in (versions[0] as object)).toBe(false);

    const second = await data<PanelReportVersionDetailDto>(await api.request(`/api/panel/reports/${report.id}/versions/2`));
    expect(JSON.stringify(second.spec)).toContain('$pageview');
    expect((await api.request(`/api/panel/reports/${report.id}/versions/9`)).status).toBe(404);
    expect((await api.request(`/api/panel/reports/${report.id}/versions/abc`)).status).toBe(404);
  });

  it('restores a version, keeping the current state as a new one, with an updated event', async () => {
    const report = await newReport('user_alice', { visibility: 'workspace' });
    const api = reports('user_alice');
    await api.request(`/api/panel/reports/${report.id}`, json({ name: 'Signups', description: 'who signs up', spec: TRENDS('pnp_a', 'Signed up') }, 'PATCH'));
    events = [];

    const restored = await api.request(`/api/panel/reports/${report.id}/versions/1/restore`, { method: 'POST' });
    expect(restored.status).toBe(200);
    const body = await data<PanelReportDto>(restored);
    expect(body).toMatchObject({ name: 'Weekly visitors', description: null, kind: 'trends' });
    expect(JSON.stringify(body.spec)).toContain('$pageview');
    expect(events).toMatchObject([{ entityType: 'panel_report', action: 'updated', entityId: report.id }]);

    const versions = await data<PanelReportVersionDto[]>(await api.request(`/api/panel/reports/${report.id}/versions`));
    expect(versions.map((v) => [v.version, v.name])).toEqual([
      [2, 'Signups'],
      [1, 'Weekly visitors'],
    ]);
    // And back again.
    const again = await data<PanelReportDto>(await api.request(`/api/panel/reports/${report.id}/versions/2/restore`, { method: 'POST' }));
    expect(again).toMatchObject({ name: 'Signups', description: 'who signs up' });
  });

  it('shows versions only to who may see the report, and restores only for who may change it', async () => {
    const priv = await newReport('user_alice');
    await reports('user_alice').request(`/api/panel/reports/${priv.id}`, json({ name: 'Two' }, 'PATCH'));
    expect((await reports('user_bob').request(`/api/panel/reports/${priv.id}/versions`)).status).toBe(404);
    expect((await reports('user_root', ADMIN).request(`/api/panel/reports/${priv.id}/versions/1`)).status).toBe(404);

    const shared = await newReport('user_alice', { visibility: 'workspace' });
    await reports('user_alice').request(`/api/panel/reports/${shared.id}`, json({ name: 'Two' }, 'PATCH'));
    expect((await reports('user_bob').request(`/api/panel/reports/${shared.id}/versions`)).status).toBe(200);
    expect((await reports('user_bob').request(`/api/panel/reports/${shared.id}/versions/1/restore`, { method: 'POST' })).status).toBe(403);
    expect((await reports('user_bob', READER).request(`/api/panel/reports/${shared.id}/versions/1/restore`, { method: 'POST' })).status).toBe(403);
    expect((await reports('user_root', ADMIN).request(`/api/panel/reports/${shared.id}/versions/1/restore`, { method: 'POST' })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Metric trees
// ---------------------------------------------------------------------------

describe('metric trees', () => {
  const singleSpec = (projectId = 'pnp_a', event = 'Signed up') => ({ kind: 'trends', projectId, series: [{ event }] });

  async function validNodes() {
    const report = await newReport('user_alice', { visibility: 'workspace' });
    return [
      { id: 'root', label: 'Weekly active users', parentId: null, relation: null, metric: { reportId: report.id } },
      { id: 'new', label: 'New users', parentId: 'root', relation: 'sum', metric: { spec: singleSpec() } },
      { id: 'returning', label: 'Returning users', parentId: 'root', relation: 'influence', metric: { spec: singleSpec('pnp_a', 'Logged in') } },
    ];
  }

  it('creates a tree and keeps its nodes off the bus', async () => {
    const nodes = await validNodes();
    events = [];
    const res = await trees('user_alice').request('/api/panel/metric-trees', json({ projectId: 'pnp_a', name: 'Growth', nodes }));
    expect(res.status).toBe(201);
    const tree = await data<PanelMetricTreeDto>(res);
    expect(tree.id).toMatch(/^pnmt_/);
    expect(tree.nodes.map((n) => n.id)).toEqual(['root', 'new', 'returning']);
    expect(events).toMatchObject([{ entityType: 'panel_metric_tree', action: 'created', entityId: tree.id }]);
    expect(JSON.stringify(events)).not.toContain('Returning users');
  });

  it('refuses what is not a tree of trends metrics of the project', async () => {
    const nodes = await validNodes();
    const api = trees('user_alice');
    const post = (body: unknown) => api.request('/api/panel/metric-trees', json({ projectId: 'pnp_a', name: 'T', nodes: body }));

    expect((await post([...nodes, { ...nodes[1], id: 'root2', parentId: null, relation: null }])).status).toBe(400);
    expect((await post([{ ...nodes[0], parentId: 'new' }, { ...nodes[1], parentId: 'root' }])).status).toBe(400);
    expect((await post([nodes[0], { ...nodes[1], parentId: 'ghost' }])).status).toBe(400);
    expect((await post([nodes[0], { ...nodes[1], id: 'root' }])).status).toBe(400);
    expect((await post([{ ...nodes[0], relation: 'sum' }])).status).toBe(400);
    const many = Array.from({ length: 26 }, (_, i) => ({ id: `n${i}`, label: 'x', parentId: i === 0 ? null : 'n0', relation: i === 0 ? null : 'sum', metric: { spec: singleSpec() } }));
    expect((await post(many)).status).toBe(400);
    const twoSeries = { kind: 'trends', projectId: 'pnp_a', series: [{ event: 'A' }, { event: 'B' }] };
    expect((await post([nodes[0], { ...nodes[1], metric: { spec: twoSeries } }])).status).toBe(400);
    expect((await post([nodes[0], { ...nodes[1], metric: { spec: singleSpec('pnp_b') } }])).status).toBe(400);

    const otherProject = await newReport('user_alice', { visibility: 'workspace' }, 'pnp_b');
    expect((await post([{ ...nodes[0], metric: { reportId: otherProject.id } }])).status).toBe(400);
    const funnel = await newReport('user_alice', { visibility: 'workspace', spec: { kind: 'funnel', projectId: 'pnp_a', steps: [{ event: 'A' }, { event: 'B' }] } });
    expect((await post([{ ...nodes[0], metric: { reportId: funnel.id } }])).status).toBe(400);
    const bobsPrivate = await newReport('user_bob');
    expect((await post([{ ...nodes[0], metric: { reportId: bobsPrivate.id } }])).status).toBe(400);
    expect(await db.select().from(panelMetricTrees)).toHaveLength(0);
  });

  it('follows the report visibility rule', async () => {
    const nodes = await validNodes();
    const mine = await data<PanelMetricTreeDto>(await trees('user_alice').request('/api/panel/metric-trees', json({ projectId: 'pnp_a', name: 'Mine', nodes })));
    const shared = await data<PanelMetricTreeDto>(
      await trees('user_alice').request('/api/panel/metric-trees', json({ projectId: 'pnp_a', name: 'Shared', visibility: 'workspace', nodes })),
    );
    const bob = trees('user_bob');
    expect((await data<PanelMetricTreeDto[]>(await bob.request('/api/panel/metric-trees?projectId=pnp_a'))).map((t) => t.id)).toEqual([shared.id]);
    expect((await bob.request(`/api/panel/metric-trees/${mine.id}`)).status).toBe(404);
    expect((await bob.request(`/api/panel/metric-trees/${shared.id}`, json({ name: 'Bob' }, 'PATCH'))).status).toBe(403);
    expect((await trees('user_root', ADMIN).request(`/api/panel/metric-trees/${shared.id}`, json({ name: 'Admin' }, 'PATCH'))).status).toBe(200);
    expect((await trees('user_alice').request(`/api/panel/metric-trees/${mine.id}`, json({ nodes: [nodes[0]] }, 'PATCH'))).status).toBe(200);
    expect((await trees('user_alice').request(`/api/panel/metric-trees/${mine.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await trees('user_alice').request(`/api/panel/metric-trees/${mine.id}`)).status).toBe(404);
    expect((await trees('user_alice', READER).request('/api/panel/metric-trees', json({ projectId: 'pnp_a', name: 'x', nodes }))).status).toBe(403);
  });
});
