/**
 * Every /api/feature-requests route against real pglite master and tenant
 * databases, refusals included: the board's sort orders and filter, the
 * columns it keeps on the server, the totals, submitting (with the
 * submitter's name from the tenant member row) and toggling a vote.
 *
 * Nothing is mocked but `getMasterDb`, which hands out the test's master
 * database through `conformanceMasterDb`, so the conformance suite runs these
 * against the Rust backend too.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  const { conformanceMasterDb } = await import('@weldsuite/worker-kit/testing/conformance');
  return { ...actual, getMasterDb: () => conformanceMasterDb(state.master) };
});

import { featureRequestsRoutes } from './index';

const { featureRequests } = masterSchema;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
let tenant: Database;

const ME = 'user_fr_me';

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  state.master = master;
  tenant = (await createPgliteDb()).db;

  await master.insert(featureRequests).values([
    {
      id: 'freq_dark',
      title: 'Dark mode',
      description: 'Please',
      type: 'feature',
      status: 'planned',
      submitterId: 'user_fr_a',
      submitterName: 'Ann',
      submitterEmail: 'ann@fr.test',
      adminNotes: 'Q3',
      voteCount: 2,
      voters: ['user_fr_a', ME],
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
      updatedAt: new Date('2026-01-02T10:00:00.000Z'),
    },
    {
      id: 'freq_crash',
      title: 'Crash on save',
      description: 'It crashes',
      type: 'bug',
      status: 'completed',
      submitterId: 'user_fr_b',
      submitterName: 'Bob',
      submitterEmail: 'bob@fr.test',
      voteCount: 5,
      voters: ['user_fr_b', 'user_fr_c', 'user_fr_d', 'user_fr_e', 'user_fr_f'],
      createdAt: new Date('2026-02-01T10:00:00.000Z'),
      updatedAt: new Date('2026-02-01T10:00:00.000Z'),
      completedAt: new Date('2026-03-01T10:00:00.000Z'),
    },
    {
      id: 'freq_speed',
      title: 'Faster search',
      description: 'Make it fast',
      type: 'improvement',
      status: 'open',
      submitterId: 'user_fr_c',
      submitterName: 'Cleo',
      submitterEmail: 'cleo@fr.test',
      voteCount: 2,
      voters: null,
      createdAt: new Date('2026-03-01T10:00:00.000Z'),
      updatedAt: new Date('2026-03-01T10:00:00.000Z'),
    },
  ]);

  const now = new Date();
  await tenant.insert(schema.workspaceMembers).values([
    { id: 'wm_fr_me', userId: ME, name: 'Mia Member', email: 'mia@fr.test', role: 'MEMBER', status: 'ACTIVE', createdAt: now, updatedAt: now },
    { id: 'wm_fr_blank', userId: 'user_fr_blank', name: '', email: '', role: 'MEMBER', status: 'ACTIVE', createdAt: now, updatedAt: now },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
}, 60_000);

function app(userId = ME, perms = permissions('general:read')) {
  return createTestApp('/api/feature-requests', featureRequestsRoutes, {
    context: { userId, tenantDb: tenant, masterDb: master, permissions: perms },
  });
}

function post(t: ReturnType<typeof app>, path: string, body?: unknown) {
  return t.request(`/api/feature-requests${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface Item {
  id: string;
  hasVoted: boolean;
  [key: string]: unknown;
}

async function ids(path: string) {
  const res = await app().request(`/api/feature-requests${path}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Item[] }).data.map((r) => r.id);
}

describe('GET /api/feature-requests', () => {
  it('needs general:read', async () => {
    const res = await app(ME, permissions('crm:read')).request('/api/feature-requests');
    expect(res.status).toBe(403);
  });

  it('lists by votes (ties by id, descending), with the caller’s vote and no private columns', async () => {
    const res = await app().request('/api/feature-requests');
    const { data } = (await res.json()) as { data: Item[] };
    expect(data.map((r) => r.id)).toEqual(['freq_crash', 'freq_speed', 'freq_dark']);
    expect(data.map((r) => r.hasVoted)).toEqual([false, false, true]);
    expect(data[0]).toEqual({
      id: 'freq_crash',
      title: 'Crash on save',
      description: 'It crashes',
      type: 'bug',
      status: 'completed',
      voteCount: 5,
      submitterName: 'Bob',
      createdAt: '2026-02-01T10:00:00.000Z',
      updatedAt: '2026-02-01T10:00:00.000Z',
      completedAt: '2026-03-01T10:00:00.000Z',
      hasVoted: false,
    });
  });

  it('sorts by newest and oldest, and filters by type', async () => {
    expect(await ids('?sortBy=newest')).toEqual(['freq_speed', 'freq_crash', 'freq_dark']);
    expect(await ids('?sortBy=oldest')).toEqual(['freq_dark', 'freq_crash', 'freq_speed']);
    expect(await ids('?type=bug')).toEqual(['freq_crash']);
    expect(await ids('?type=improvement&sortBy=newest')).toEqual(['freq_speed']);
  });

  it('refuses an unknown type or sort, and a repeated one', async () => {
    for (const query of ['?type=idea', '?sortBy=random', '?type=bug&type=feature']) {
      const res = await app().request(`/api/feature-requests${query}`);
      expect(res.status).toBe(400);
    }
  });
});

describe('GET /api/feature-requests/stats', () => {
  it('needs general:read', async () => {
    const res = await app(ME, permissions()).request('/api/feature-requests/stats');
    expect(res.status).toBe(403);
  });

  it('totals the board by status and type', async () => {
    const res = await app().request('/api/feature-requests/stats');
    expect(await res.json()).toEqual({
      data: {
        total: 3,
        open: 1,
        underReview: 0,
        planned: 1,
        inProgress: 0,
        completed: 1,
        declined: 0,
        features: 1,
        bugs: 1,
        improvements: 1,
      },
    });
  });
});

describe('POST /api/feature-requests', () => {
  it('needs general:read', async () => {
    const res = await post(app(ME, permissions()), '', { title: 'x', description: 'y' });
    expect(res.status).toBe(403);
  });

  it('validates the body', async () => {
    const res = await post(app(), '', { title: '', description: '', type: null });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { issues: Array<{ message: string }> } };
    expect(body.error.issues.map((i) => i.message)).toEqual([
      'Title is required',
      'Description is required',
      "Expected 'feature' | 'bug' | 'improvement', received null",
    ]);
    const long = await post(app(), '', { title: 'x'.repeat(501), description: 'y', type: 'idea' });
    expect(long.status).toBe(400);
  });

  it('submits a feature by default, signed with the member row', async () => {
    const res = await post(app(), '', { title: 'Export to CSV', description: 'From every list' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Item };
    expect(data).toEqual({
      id: expect.stringMatching(/^freq_/),
      title: 'Export to CSV',
      description: 'From every list',
      type: 'feature',
      status: 'open',
      submitterId: ME,
      submitterName: 'Mia Member',
      submitterEmail: 'mia@fr.test',
      adminNotes: null,
      voteCount: 0,
      voters: [],
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      completedAt: null,
      hasVoted: false,
    });
    const [row] = await master.select().from(featureRequests).where(eq(featureRequests.id, data.id));
    expect(row).toMatchObject({ submitterName: 'Mia Member', type: 'feature' });
  });

  it('signs as Unknown without a member row, or with a blank one', async () => {
    for (const user of ['user_fr_stranger', 'user_fr_blank']) {
      const res = await post(app(user), '', { title: 'Bug', description: 'Broken', type: 'bug' });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { data: Item }).data).toMatchObject({
        type: 'bug',
        submitterName: 'Unknown',
        submitterEmail: '',
      });
    }
  });
});

describe('POST /api/feature-requests/:id/vote', () => {
  it('needs general:read', async () => {
    const res = await post(app(ME, permissions()), '/freq_speed/vote');
    expect(res.status).toBe(403);
  });

  it('is a 404 for an unknown request', async () => {
    const res = await post(app(), '/freq_missing/vote');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: "Feature request with ID 'freq_missing' not found" },
    });
  });

  it('adds the caller’s vote to a request without voters, then takes it back', async () => {
    const on = await post(app(), '/freq_speed/vote');
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ data: { voteCount: 1, voters: [ME], hasVoted: true } });

    const off = await post(app(), '/freq_speed/vote');
    expect(await off.json()).toEqual({ data: { voteCount: 0, voters: [], hasVoted: false } });
  });

  it('removes an existing vote and recounts from the voters', async () => {
    const res = await post(app(), '/freq_dark/vote');
    expect(await res.json()).toEqual({ data: { voteCount: 1, voters: ['user_fr_a'], hasVoted: false } });
    const [row] = await master.select().from(featureRequests).where(eq(featureRequests.id, 'freq_dark'));
    expect(row).toMatchObject({ voteCount: 1, voters: ['user_fr_a'] });
  });
});
