/**
 * WeldDesk routing rules, /api/desk/routing, on pglite: the rules round trip
 * normalised, the schema refuses what the engine can't read, saving keeps the
 * rest of `automation` (auto-assignment), and the gates. Runs against Rust in
 * conformance mode (rust/conformance/suites.json, "desk: settings").
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { deskRoutingRoutes } from './index';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.helpdeskSettings);
});

const BASE = '/api/desk/routing';

const app = (...perms: string[]) =>
  createTestApp(BASE, deskRoutingRoutes, {
    context: { permissions: permissions(...perms), tenantDb: db, userId: 'user_admin' },
  }).request;

const put = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const vip = {
  id: 'rule_vip',
  name: 'VIP to tier 2',
  enabled: true,
  conditions: { tags: ['vip'], channels: ['email', 'messenger'], priorities: [] },
  actions: { departmentId: 'dep_t2', priority: 'high', addTags: ['escalated'], assigneeId: null },
};

describe('/api/desk/routing', () => {
  it('starts with no rules', async () => {
    const res = await app('settings:read')(BASE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { rules: [] } });
  });

  it('saves the ordered rules, normalised', async () => {
    const res = await app('settings:update')(
      BASE,
      put({
        rules: [
          vip,
          { id: 'rule_phone', name: 'Phone', enabled: false, conditions: { channels: ['phone'] }, actions: { assigneeId: 'user_ann' } },
          { id: 'rule_vip', name: 'Repeat id', enabled: true, conditions: {}, actions: {} },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const expected = {
      rules: [
        {
          id: 'rule_vip',
          name: 'VIP to tier 2',
          enabled: true,
          conditions: { channels: ['email', 'messenger'], tags: ['vip'] },
          actions: { departmentId: 'dep_t2', priority: 'high', addTags: ['escalated'] },
        },
        {
          id: 'rule_phone',
          name: 'Phone',
          enabled: false,
          conditions: { channels: ['phone'] },
          actions: { assigneeId: 'user_ann' },
        },
      ],
    };
    expect(await res.json()).toEqual({ data: expected });
    const read = await app('settings:read')(BASE);
    expect(await read.json()).toEqual({ data: expected });
  });

  it('keeps auto-assignment and the legacy automation keys', async () => {
    await db.insert(schema.helpdeskSettings).values({
      id: 'hds_routing',
      automation: {
        enabled: true,
        slaBreachAction: 'notify_only',
        deskAssignment: { mode: 'balanced', memberIds: ['user_ann'], awayMemberIds: [], maxOpenPerMember: 3 },
      },
    });
    const res = await app('settings:update')(BASE, put({ rules: [vip] }));
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.helpdeskSettings);
    expect(row!.automation).toMatchObject({
      enabled: true,
      slaBreachAction: 'notify_only',
      deskAssignment: { mode: 'balanced', memberIds: ['user_ann'], maxOpenPerMember: 3 },
      deskRouting: { rules: [{ id: 'rule_vip' }] },
    });
    // An empty list clears the rules, nothing else.
    expect((await app('settings:update')(BASE, put({ rules: [] }))).status).toBe(200);
    const [after] = await db.select().from(schema.helpdeskSettings);
    expect(after!.automation).toMatchObject({ deskRouting: { rules: [] }, deskAssignment: { mode: 'balanced' } });
  });

  it('refuses rules the engine cannot read', async () => {
    const bad = [
      {},
      { rules: 'nope' },
      { rules: [{ ...vip, name: '' }] },
      { rules: [{ ...vip, id: 'x'.repeat(65) }] },
      { rules: [{ ...vip, enabled: 'yes' }] },
      { rules: [{ ...vip, conditions: { channels: ['fax'] } }] },
      { rules: [{ ...vip, conditions: { tags: ['x'.repeat(51)] } }] },
      { rules: [{ ...vip, actions: { priority: 'critical' } }] },
      { rules: [{ ...vip, actions: { departmentId: '' } }] },
      { rules: [{ ...vip, conditions: undefined }] },
      { rules: Array.from({ length: 101 }, (_, i) => ({ ...vip, id: `r${i}` })) },
    ];
    for (const body of bad) {
      const res = await app('settings:update')(BASE, put(body));
      expect(res.status, JSON.stringify(body).slice(0, 120)).toBe(400);
    }
  });

  it('needs settings:read to read and settings:update to save', async () => {
    expect((await app('conversations:read')(BASE)).status).toBe(403);
    expect((await app('settings:read')(BASE, put({ rules: [] }))).status).toBe(403);
  });
});
