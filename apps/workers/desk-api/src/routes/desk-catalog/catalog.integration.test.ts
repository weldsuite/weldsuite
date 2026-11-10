/**
 * The service catalogue items on pglite: create / read / change / delete with
 * their validation (the form is an active customer ticket type, a team is
 * active, limits, ids), the `desk_catalog_item` entity events, the pending
 * approvals list per scope and the permission gates. Seeded rows have fixed
 * ids, so the suite runs against Rust too.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { deskCatalogRoutes } from './index';

vi.setConfig({ testTimeout: 120_000 });

const BASE = '/api/desk/catalog';

let db: Database;
const events: Array<{ entityType: string; action: string; entityId: string }> = [];

const routes = new Hono<{ Bindings: Env; Variables: Variables }>().route('/', deskCatalogRoutes);

const app = (keys: string[], userId = 'user_test_default') =>
  createTestApp(BASE, routes, {
    context: { permissions: permissions(...keys), tenantDb: db, userId },
    env: {
      DATABASE_URL_MASTER: undefined,
      ENTITY_EVENTS: {
        send: async (message: { entityType: string; action: string; entityId: string }) => {
          events.push(message);
        },
      },
    } as never,
  });
const reader = (userId?: string) => app(['conversations:read'], userId);
const manager = () => app(['conversations:read', 'settings:read', 'settings:update']);

const send = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second));

interface Item {
  id: string;
  name: string;
  category: string | null;
  isActive: boolean;
  sortOrder: number;
  ticketTypeId: string;
  approvalSteps: Array<{ id: string; approverType: string; approverId?: string; name?: string; departmentId?: string | null }>;
  fulfilmentTasks: Array<{ id: string; title: string; assigneeId?: string | null; dueInDays?: number | null }>;
}
interface ErrorBody {
  error: { details: { field?: string; reason?: string } };
}

const valid = (extra: Record<string, unknown> = {}) => ({ name: 'New laptop', ticketTypeId: 'ttyp_hw', ...extra });

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_alice', userId: 'user_alice', name: 'Alice', status: 'ACTIVE' },
    { id: 'wm_gone', userId: 'user_gone', name: 'Gone', status: 'SUSPENDED' },
  ]);
  await db.insert(schema.helpdeskTicketTypes).values([
    { id: 'ttyp_hw', name: 'Hardware request', category: 'customer', isActive: true },
    { id: 'ttyp_inactive', name: 'Old form', category: 'customer', isActive: false },
    { id: 'ttyp_internal', name: 'Internal only', category: 'internal', isActive: true },
  ]);
  await db.insert(schema.helpdeskDepartments).values([
    { id: 'dept_it', name: 'IT', isActive: true },
    { id: 'dept_off', name: 'Closed team', isActive: false },
  ]);
  // Two requests waiting for different approvers.
  for (const [i, approverId] of [
    [1, 'user_alice'],
    [2, 'user_test_default'],
    [3, null],
  ] as const) {
    await db.insert(schema.deskConversations).values({
      id: `dconv_${i}`,
      conversationNumber: 800 + i,
      name: `Requester ${i}`,
      title: `Request ${i}`,
      catalogItemId: 'dcat_seed',
      approvalStatus: 'pending',
      createdAt: at(i),
      updatedAt: at(i),
    });
    await db.insert(schema.deskRequestApprovals).values({
      id: `dappr_${i}`,
      conversationId: `dconv_${i}`,
      catalogItemId: 'dcat_seed',
      stepIndex: 0,
      stepName: 'Budget',
      approverId,
      status: 'pending',
      createdAt: at(i),
      updatedAt: at(i),
    });
  }
  await db.insert(schema.deskRequestApprovals).values({
    id: 'dappr_done',
    conversationId: 'dconv_1',
    catalogItemId: 'dcat_seed',
    stepIndex: 1,
    approverId: 'user_alice',
    status: 'waiting',
    createdAt: at(1),
    updatedAt: at(1),
  });
}, 60_000);

describe('POST /api/desk/catalog', () => {
  it('creates an item with defaults, generated step and task ids, and publishes it', async () => {
    const res = await manager().request(
      BASE,
      send(
        valid({
          summary: '  A work laptop ',
          category: 'Hardware',
          approvalSteps: [{ approverType: 'member', approverId: 'user_alice', name: 'Budget' }],
          fulfilmentTasks: [{ title: 'Order it', dueInDays: 3 }, { title: 'Image it' }],
        }),
      ),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Item & { summary: string } };
    expect(data.id.startsWith('dcat_')).toBe(true);
    expect(data).toMatchObject({ name: 'New laptop', summary: 'A work laptop', category: 'Hardware', isActive: true, sortOrder: 0 });
    expect(data.approvalSteps).toEqual([{ id: expect.stringMatching(/^dstep_/), name: 'Budget', approverType: 'member', approverId: 'user_alice' }]);
    expect(data.fulfilmentTasks.map((t) => [t.title, t.dueInDays ?? null])).toEqual([['Order it', 3], ['Image it', null]]);
    expect(data.fulfilmentTasks[0]?.id).toMatch(/^dtask_/);
    expect(events).toContainEqual(expect.objectContaining({ entityType: 'desk_catalog_item', action: 'created', entityId: data.id }));
  });

  it('refuses a form that is not an active customer ticket type', async () => {
    for (const ticketTypeId of ['ttyp_inactive', 'ttyp_internal', 'ttyp_nope']) {
      const res = await manager().request(BASE, send(valid({ ticketTypeId })));
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorBody).error.details.field).toBe('ticketTypeId');
    }
  });

  it('refuses an inactive team and a member step without an active member', async () => {
    const team = await manager().request(BASE, send(valid({ departmentId: 'dept_off' })));
    expect(((await team.json()) as ErrorBody).error.details.field).toBe('departmentId');
    const member = await manager().request(BASE, send(valid({ approvalSteps: [{ approverType: 'member', approverId: 'user_gone' }] })));
    expect(member.status).toBe(400);
    expect(((await member.json()) as ErrorBody).error.details.field).toBe('approvalSteps');
    const none = await manager().request(BASE, send(valid({ approvalSteps: [{ approverType: 'member' }] })));
    expect(none.status).toBe(400);
    const teamStep = await manager().request(BASE, send(valid({ approvalSteps: [{ approverType: 'team_manager', departmentId: 'dept_off' }] })));
    expect(((await teamStep.json()) as ErrorBody).error.details.field).toBe('approvalSteps');
  });

  it('caps steps at five and tasks at twenty, and wants unique ids', async () => {
    const steps = Array.from({ length: 6 }, () => ({ approverType: 'team_manager' }));
    expect((await manager().request(BASE, send(valid({ approvalSteps: steps })))).status).toBe(400);
    const tasks = Array.from({ length: 21 }, (_, i) => ({ title: `Task ${i}` }));
    expect((await manager().request(BASE, send(valid({ fulfilmentTasks: tasks })))).status).toBe(400);
    const dupSteps = await manager().request(
      BASE,
      send(valid({ approvalSteps: [{ id: 'same', approverType: 'team_manager' }, { id: 'same', approverType: 'team_manager' }] })),
    );
    expect(((await dupSteps.json()) as ErrorBody).error.details.field).toBe('approvalSteps');
    const dupTasks = await manager().request(BASE, send(valid({ fulfilmentTasks: [{ id: 't', title: 'A' }, { id: 't', title: 'B' }] })));
    expect(((await dupTasks.json()) as ErrorBody).error.details.field).toBe('fulfilmentTasks');
    expect((await manager().request(BASE, send(valid({ name: '   ' })))).status).toBe(400);
  });

  it('needs settings:update', async () => {
    expect((await reader().request(BASE, send(valid()))).status).toBe(403);
  });
});

describe('reading the catalogue', () => {
  let activeId: string;
  let offId: string;

  beforeAll(async () => {
    const make = async (body: Record<string, unknown>) => {
      const res = await manager().request(BASE, send(valid(body)));
      return ((await res.json()) as { data: Item }).data.id;
    };
    activeId = await make({ name: 'Access to CRM', category: 'Access', sortOrder: 1 });
    offId = await make({ name: 'Retired item', isActive: false, sortOrder: 2 });
  });

  it('lists the active items by sort order and name, and 404s an unknown one', async () => {
    const res = await reader().request(BASE);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Item[] };
    expect(data.map((i) => i.id)).toContain(activeId);
    expect(data.map((i) => i.id)).not.toContain(offId);
    expect(data.map((i) => i.sortOrder)).toEqual([...data.map((i) => i.sortOrder)].sort((a, b) => a - b));
    expect((await reader().request(`${BASE}/${activeId}`)).status).toBe(200);
    expect((await reader().request(`${BASE}/dcat_nope`)).status).toBe(404);
  });

  it('shows switched-off items only to someone with settings:read', async () => {
    expect((await reader().request(`${BASE}?all=1`)).status).toBe(403);
    const { data } = (await (await manager().request(`${BASE}?all=1`)).json()) as { data: Item[] };
    expect(data.map((i) => i.id)).toContain(offId);
  });
});

describe('PATCH and DELETE /api/desk/catalog/:id', () => {
  let id: string;

  beforeAll(async () => {
    const res = await manager().request(BASE, send(valid({ name: 'Mobile phone', category: 'Hardware' })));
    id = ((await res.json()) as { data: Item }).data.id;
  });

  it('changes only the keys it carries, validating them, and publishes the update', async () => {
    const res = await manager().request(`${BASE}/${id}`, send({ category: null, isActive: false, sortOrder: 5 }, 'PATCH'));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Item };
    expect(data).toMatchObject({ name: 'Mobile phone', category: null, isActive: false, sortOrder: 5, ticketTypeId: 'ttyp_hw' });
    expect(events).toContainEqual(expect.objectContaining({ entityType: 'desk_catalog_item', action: 'updated', entityId: id }));

    const bad = await manager().request(`${BASE}/${id}`, send({ ticketTypeId: 'ttyp_internal' }, 'PATCH'));
    expect(bad.status).toBe(400);
    expect((await manager().request(`${BASE}/dcat_nope`, send({ name: 'X' }, 'PATCH'))).status).toBe(404);
    expect((await reader().request(`${BASE}/${id}`, send({ name: 'X' }, 'PATCH'))).status).toBe(403);
  });

  it('deletes an item (204) and publishes it; a second delete is a 404', async () => {
    expect((await reader().request(`${BASE}/${id}`, { method: 'DELETE' })).status).toBe(403);
    const res = await manager().request(`${BASE}/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(events).toContainEqual(expect.objectContaining({ entityType: 'desk_catalog_item', action: 'deleted', entityId: id }));
    expect((await manager().request(`${BASE}/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await reader().request(`${BASE}/${id}`)).status).toBe(404);
  });
});

describe('GET /api/desk/catalog/approvals', () => {
  it("lists the caller's own pending steps by default, oldest first, with the conversation", async () => {
    const res = await reader('user_alice').request(`${BASE}/approvals`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ approvalId: string; conversationNumber: number; requesterName: string; stepName: string; catalogItemName: string | null }> };
    expect(data).toEqual([
      expect.objectContaining({ approvalId: 'dappr_1', conversationNumber: 801, requesterName: 'Requester 1', stepName: 'Budget', catalogItemName: null }),
    ]);
    const mine = (await (await manager().request(`${BASE}/approvals?scope=mine`)).json()) as { data: Array<{ approvalId: string }> };
    expect(mine.data.map((r) => r.approvalId)).toEqual(['dappr_2']);
  });

  it("shows everyone's, steps without an approver included, only with settings:update", async () => {
    expect((await reader().request(`${BASE}/approvals?scope=all`)).status).toBe(403);
    const { data } = (await (await manager().request(`${BASE}/approvals?scope=all`)).json()) as { data: Array<{ approvalId: string }> };
    expect(data.map((r) => r.approvalId)).toEqual(['dappr_1', 'dappr_2', 'dappr_3']);
    // The waiting step of dconv_1 is not pending, so it is not listed.
    expect(data.map((r) => r.approvalId)).not.toContain('dappr_done');
  });

  it('validates the scope and needs conversations:read', async () => {
    expect((await reader().request(`${BASE}/approvals?scope=nobody`)).status).toBe(400);
    expect((await app(['tickets:read']).request(`${BASE}/approvals`)).status).toBe(403);
  });
});
