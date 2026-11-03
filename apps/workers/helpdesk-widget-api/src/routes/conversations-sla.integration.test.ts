/**
 * SLA clocks on visitor writes, through the whole worker on pglite: with an
 * SLA policy stored, a new conversation and every later visitor message
 * re-derive the conversation's clocks (`refreshDeskSla`, inside
 * `appendDeskMessage`), and the background auto-assignment re-derives them
 * again, since a policy can have a condition on the assignee.
 *
 * Conformance-ready: in conformance mode the clocks and the summary the
 * assertions read are Rust's.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as tenantSchema from '@weldsuite/db/schema';
import { appendDeskMessage } from '@weldsuite/db/lib/desk';
import { generateId } from '@weldsuite/worker-kit/id';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { WIDGET, addWidget, at, json, member, seedWorkspaces, visitorRow, visitorToken, widgetEnv } from '../test/widget-fixtures';

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
  getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
  getWorkspaceForOrg: async () => ({ id: 'ws_acme' }),
}));

import worker from '../index';

const { deskConversations, deskSlaClocks, helpdeskSettings, helpdeskSlas, workspaceMembers } = tenantSchema;

const BASE = '/api/conversations';
const MINUTE = 60_000;

let tenantDb: Database;
let masterDb: Database;

function app() {
  return createTestApp('/', worker as never, {
    context: { tenantDb, masterDb, orgId: null, clerkOrgId: null },
    env: widgetEnv(),
    rustBasePath: '/public/helpdesk-widget',
  });
}

const call = (path: string, init?: RequestInit) => app().request(path, init);

const conversationRow = async (id: string) =>
  (await tenantDb.select().from(deskConversations).where(eq(deskConversations.id, id)))[0]!;

const clocksOf = async (id: string) =>
  Object.fromEntries(
    (await tenantDb.select().from(deskSlaClocks).where(eq(deskSlaClocks.conversationId, id))).map((c) => [c.metric, c]),
  );

async function startAs(visitorId: string, body: string) {
  const res = await call(BASE, json({ name: 'Nora', body }, { token: await visitorToken(visitorId) }));
  expect(res.status).toBe(201);
  const { data } = (await res.json()) as { data: { conversation: { id: string } } };
  return data.conversation.id;
}

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
  holder.master = masterDb;
  holder.tenant = tenantDb;
  await seedWorkspaces(masterDb);
  await addWidget(masterDb, tenantDb, WIDGET);
  await tenantDb
    .insert(tenantSchema.deskVisitors)
    .values([visitorRow('vis_sla_start'), visitorRow('vis_sla_cycle'), visitorRow('vis_sla_owned')]);
  await tenantDb.insert(workspaceMembers).values([member('user_ann', { name: 'Ann Agent' })]);
  await tenantDb.insert(helpdeskSlas).values([
    {
      id: 'sla_widget_default',
      name: 'Standard',
      createdAt: at(0),
      updatedAt: at(0),
      isDefault: true,
      isActive: true,
      operationalHours: '24x7',
      firstResponseTime: [{ priority: 'medium', time: 60 }],
      resolutionTime: [{ priority: 'medium', time: 480 }],
      updateTime: [{ priority: 'medium', time: 120 }],
    },
    {
      id: 'sla_widget_ann',
      name: 'Ann owns it',
      createdAt: at(0),
      updatedAt: at(0),
      isActive: true,
      operationalHours: '24x7',
      conditions: [{ field: 'assigneeId', operator: 'equals', value: 'user_ann' }],
      firstResponseTime: [{ priority: 'medium', time: 20 }],
    },
  ]);
}, 120_000);

beforeEach(async () => {
  await tenantDb.delete(helpdeskSettings);
});

describe('SLA clocks on visitor writes', () => {
  it('starts first response and resolution on a new conversation', async () => {
    const id = await startAs('vis_sla_start', 'My parcel never arrived');
    const row = await conversationRow(id);
    expect(row).toMatchObject({ slaPolicyId: 'sla_widget_default', slaStatus: 'active', slaMetric: 'first_response' });
    const clocks = await clocksOf(id);
    expect(Object.keys(clocks).sort()).toEqual(['first_response', 'resolution']);
    const started = clocks.first_response!.startedAt.getTime();
    expect(row.slaDueAt?.getTime()).toBe(started + 60 * MINUTE);
    expect(clocks.first_response!.nextCheckAt?.getTime()).toBe(started + 45 * MINUTE);
  });

  it('runs a next-response cycle when the visitor writes after an agent reply', async () => {
    const id = await startAs('vis_sla_cycle', 'Hello?');
    await appendDeskMessage(tenantDb, {
      generateId,
      conversationId: id,
      kind: 'message',
      authorType: 'agent',
      authorId: 'user_ann',
      body: 'Hi Nora!',
    });
    expect((await conversationRow(id)).slaStatus).toBe('paused');

    const res = await call(`${BASE}/${id}/messages`, json({ body: 'One more thing' }, { token: await visitorToken('vis_sla_cycle') }));
    expect(res.status).toBe(201);
    const row = await conversationRow(id);
    expect(row).toMatchObject({ slaStatus: 'active', slaMetric: 'next_response' });
    const clocks = await clocksOf(id);
    expect(clocks.next_response).toMatchObject({ status: 'running', targetMinutes: 120 });
    expect(clocks.resolution).toMatchObject({ status: 'running' });
  });

  it('re-derives when the background auto-assignment picks an owner', async () => {
    await tenantDb.insert(helpdeskSettings).values({
      id: 'hds_sla_assign',
      createdAt: at(0),
      updatedAt: at(0),
      automation: {
        enabled: false,
        deskAssignment: { mode: 'balanced', memberIds: ['user_ann'], awayMemberIds: [], maxOpenPerMember: null },
      },
    });
    const id = await startAs('vis_sla_owned', 'Can someone help?');
    const row = await vi.waitFor(
      async () => {
        const current = await conversationRow(id);
        expect(current.assigneeId).toBe('user_ann');
        expect(current.slaPolicyId).toBe('sla_widget_ann');
        return current;
      },
      { timeout: 10_000, interval: 25 },
    );
    const clocks = await clocksOf(id);
    expect(Object.keys(clocks)).toEqual(['first_response']);
    expect(row.slaDueAt?.getTime()).toBe(clocks.first_response!.startedAt.getTime() + 20 * MINUTE);
  });
});
