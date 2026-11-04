/**
 * /api/journal-entries (pglite): the WeldFlow project cost tag on the lines of
 * a manual entry (FLOW-019). A line carries `projectId` (null leaves it
 * untagged); the project has to be a live one of the workspace; the tag is
 * returned on the created lines and the entry's detail, and a reversal copies
 * it so the pair nets to zero for the project.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { journalEntriesRoutes } from './index';

let db: Database;
const ENTITY = 'ent_je_project';
const PROJECT = 'proj_je_live';
const DELETED_PROJECT = 'proj_je_deleted';

async function call(path: string, opts: { method?: string; body?: unknown } = {}) {
  const { request } = createTestApp('/api/journal-entries', journalEntriesRoutes, {
    context: { permissions: permissions('*'), tenantDb: db },
  });
  const res = await request(`/api/journal-entries${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Accounting-Entity-Id': ENTITY },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  const json = text ? (JSON.parse(text) as { data?: any; error?: { message: string } }) : {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, ...json };
}

const entry = (lines: Array<Record<string, unknown>>) => ({ date: '2026-03-10', description: 'Licence', lines });

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.entities).values({ id: ENTITY, name: 'Project BV', jurisdictionCode: 'NL', baseCurrency: 'EUR' });
  await db.insert(schema.accounts).values([
    { id: 'acc_lic', entityId: ENTITY, code: '4400', name: 'Licences', type: 'expense', normalSide: 'debit' },
    { id: 'acc_bk', entityId: ENTITY, code: '1100', name: 'Bank', type: 'asset', normalSide: 'debit' },
  ]);
  const now = new Date();
  await db.insert(schema.projects).values([
    { id: PROJECT, name: 'Portal', createdAt: now, updatedAt: now },
    { id: DELETED_PROJECT, name: 'Gone', createdAt: now, updatedAt: now, deletedAt: now },
  ]);
}, 60_000);

describe('project tag on manual journal lines', () => {
  let id: string;

  it('stores the tag on a line and leaves the others untagged', async () => {
    const res = await call('', {
      method: 'POST',
      body: entry([
        { accountId: 'acc_lic', debit: '300.00', projectId: PROJECT },
        { accountId: 'acc_bk', credit: '300.00', projectId: null },
      ]),
    });
    expect(res.status).toBe(201);
    id = res.data.id;
    expect(res.data.lines[0]).toMatchObject({ accountId: 'acc_lic', projectId: PROJECT });
    expect(res.data.lines[1]).toMatchObject({ accountId: 'acc_bk', projectId: null });
  });

  it('returns the tag on the entry detail', async () => {
    const res = await call(`/${id}`);
    expect(res.status).toBe(200);
    expect(res.data.lines.map((l: { projectId: string | null }) => l.projectId)).toEqual([PROJECT, null]);
  });

  it('leaves a line untagged when projectId is left out', async () => {
    const res = await call('', {
      method: 'POST',
      body: entry([{ accountId: 'acc_lic', debit: '10.00' }, { accountId: 'acc_bk', credit: '10.00' }]),
    });
    expect(res.status).toBe(201);
    expect(res.data.lines.map((l: { projectId: string | null }) => l.projectId)).toEqual([null, null]);
  });

  it('copies the tag onto the reversal of the posted entry', async () => {
    expect((await call(`/${id}/post`, { method: 'POST' })).status).toBe(200);
    const reversal = await call(`/${id}/reverse`, { method: 'POST' });
    expect(reversal.status).toBe(201);
    const detail = await call(`/${reversal.data.id}`);
    const tagged = detail.data.lines.find((l: { accountId: string }) => l.accountId === 'acc_lic');
    expect(tagged).toMatchObject({ projectId: PROJECT, credit: '300.00' });
  });

  it('refuses a project that does not exist', async () => {
    const res = await call('', {
      method: 'POST',
      body: entry([{ accountId: 'acc_lic', debit: '5.00', projectId: 'proj_nope' }, { accountId: 'acc_bk', credit: '5.00' }]),
    });
    expect(res.status).toBe(400);
    expect(res.error?.message).toBe('Project proj_nope does not exist');
  });

  it('refuses a deleted project', async () => {
    const res = await call('', {
      method: 'POST',
      body: entry([{ accountId: 'acc_lic', debit: '5.00', projectId: DELETED_PROJECT }, { accountId: 'acc_bk', credit: '5.00' }]),
    });
    expect(res.status).toBe(400);
    expect(res.error?.message).toBe(`Project ${DELETED_PROJECT} does not exist`);
  });

  it('names every missing project once', async () => {
    const res = await call('', {
      method: 'POST',
      body: entry([
        { accountId: 'acc_lic', debit: '5.00', projectId: 'proj_a' },
        { accountId: 'acc_lic', debit: '5.00', projectId: 'proj_a' },
        { accountId: 'acc_bk', credit: '10.00', projectId: 'proj_b' },
      ]),
    });
    expect(res.status).toBe(400);
    expect(res.error?.message).toBe('Project proj_a, proj_b does not exist');
  });
});
