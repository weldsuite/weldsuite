/**
 * DB-backed integration tests for the project scope: /api/project-scope.
 * Runs against the TypeScript worker and, in conformance mode, the Rust backend.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { projectScopeRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const MANAGER = 'user_scp_manager';
const VIEWER = 'user_scp_viewer';
const OUTSIDER = 'user_scp_outsider';
const FULL = ['projects:read', 'projects:create', 'projects:update', 'projects:delete'];

let db: Database;

function as(userId: string, keys: string[] = FULL) {
  const { request } = createTestApp('/api/project-scope', projectScopeRoutes, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
  });
  return (method: string, path: string, body?: unknown) =>
    request(`/api/project-scope${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}
const data = async <T = Record<string, unknown>>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;
const errorOf = async (res: Response) => ((await res.json()) as { error: { message: string } }).error;

type Scope = {
  id: string | null;
  statement: string | null;
  inScope: string[];
  outOfScope: Array<{ text: string; reason: string | null; linkType: string | null; linkId: string | null; link: { code: string | null; title: string } | null }>;
  updatedBy: string | null;
};

const published = vi.mocked(publishEntityEvent);
const actions = () => published.mock.calls.map(([event]) => `${event.entityType}.${event.action}`);
beforeEach(() => {
  published.mockClear();
});

async function seedProject(id: string) {
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({ id, name: `Project ${id}`, projectManagerId: MANAGER, createdAt: now, updatedAt: now });
  await db.insert(schema.projectMembers).values({ id: `pm_${id}_v`, projectId: id, userId: VIEWER, role: 'viewer', isActive: true, createdAt: now, updatedAt: now, joinedAt: now });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('GET and PUT /:projectId', () => {
  it('answers an empty scope, saves it on first PUT (created) and on later ones (updated)', async () => {
    await seedProject('prj_scp_1');
    const send = as(MANAGER);
    expect(await data<Scope>(await send('GET', '/prj_scp_1'))).toMatchObject({ id: null, statement: null, inScope: [], outOfScope: [] });

    const first = await send('PUT', '/prj_scp_1', { statement: 'A portal', inScope: ['Ordering', 'Invoices'] });
    expect(first.status).toBe(200);
    const saved = await data<Scope>(first);
    expect(saved).toMatchObject({ statement: 'A portal', inScope: ['Ordering', 'Invoices'], outOfScope: [], updatedBy: MANAGER });
    expect(saved.id).not.toBeNull();

    // A list left out stays; null clears the statement.
    const second = await data<Scope>(await send('PUT', '/prj_scp_1', { statement: null, outOfScope: [{ text: 'Native app', reason: 'Later' }] }));
    expect(second).toMatchObject({ id: saved.id, statement: null, inScope: ['Ordering', 'Invoices'] });
    expect(second.outOfScope).toMatchObject([{ text: 'Native app', reason: 'Later', link: null }]);
    expect(actions()).toEqual(['project_scope.created', 'project_scope.updated']);
  });

  it('resolves out-of-scope links to a decision, a change request or another project', async () => {
    await seedProject('prj_scp_2');
    await db.insert(schema.projects).values({ id: 'prj_scp_other', name: 'Project prj_scp_other', projectManagerId: MANAGER, createdAt: new Date(), updatedAt: new Date() });
    const now = new Date();
    await db.insert(schema.projectDecisions).values({ id: 'dec_scp_1', projectId: 'prj_scp_2', number: 3, title: 'Dashboard later', status: 'decided', createdBy: MANAGER, createdAt: now, updatedAt: now });
    await db.insert(schema.projectChangeRequests).values({ id: 'cr_scp_1', projectId: 'prj_scp_2', number: 8, title: 'Pay in 3', status: 'draft', createdBy: MANAGER, createdAt: now, updatedAt: now });
    const send = as(MANAGER);
    const res = await send('PUT', '/prj_scp_2', {
      outOfScope: [
        { text: 'Dashboard', reason: 'Release 2', linkType: 'decision', linkId: 'dec_scp_1' },
        { text: 'Pay-in-3', linkType: 'change_request', linkId: 'cr_scp_1' },
        { text: 'Mobile', linkType: 'project', linkId: 'prj_scp_other' },
      ],
    });
    expect(res.status).toBe(200);
    const scope = await data<Scope>(res);
    expect(scope.outOfScope.map((i) => i.link?.code ?? i.link?.title)).toEqual(['DEC-3', 'CR-8', 'Project prj_scp_other']);
    // The other project is not the viewer's: its name stays hidden.
    expect((await data<Scope>(await as(VIEWER)('GET', '/prj_scp_2'))).outOfScope[2]?.link).toBeNull();
  });

  it('refuses a bad body, a half link, a link that is not there, viewers and outsiders', async () => {
    await seedProject('prj_scp_3');
    const send = as(MANAGER);
    const bad = async (body: unknown) => {
      const res = await send('PUT', '/prj_scp_3', body);
      return [res.status, (await errorOf(res)).message];
    };
    expect(await bad({ inScope: [''] })).toEqual([400, 'Invalid request body']);
    expect(await bad({ extra: 1 })).toEqual([400, 'Invalid request body']);
    expect(await bad({ outOfScope: [{ text: 'x', linkType: 'decision' }] })).toEqual([400, 'linkType and linkId must be given together']);
    expect(await bad({ outOfScope: [{ text: 'x', linkType: 'decision', linkId: 'dec_nope' }] })).toEqual([400, 'The linked object was not found in this project']);
    expect((await as(VIEWER)('PUT', '/prj_scp_3', { statement: 'x' })).status).toBe(403);
    expect((await as(OUTSIDER)('PUT', '/prj_scp_3', { statement: 'x' })).status).toBe(403);
    expect((await as(OUTSIDER)('GET', '/prj_scp_3')).status).toBe(403);
    expect((await as(MANAGER, ['projects:read'])('PUT', '/prj_scp_3', { statement: 'x' })).status).toBe(403);
    expect((await as(VIEWER)('GET', '/prj_scp_3')).status).toBe(200);
    expect((await send('GET', '/prj_scp_missing')).status).toBe(404);
    expect((await send('PUT', '/prj_scp_missing', { statement: 'x' })).status).toBe(404);
  });
});
