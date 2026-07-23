/**
 * Service-level integration tests for `services/workflows.ts`. Uses
 * the pglite-backed Drizzle from `test/pglite.ts` so each function
 * executes real SQL against a real (in-process) PostgreSQL.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
  listWorkflows,
  getWorkflowStats,
} from './workflows';
import { createPgliteDb } from '../test/pglite';
import type { Database } from '../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('workflows service', () => {
  it('creates a workflow with sensible defaults', async () => {
    const result = await createWorkflow(db, { name: 'svc test wf' }, 'user_test');
    expect(result.id).toMatch(/^wf_/);

    const fetched = await getWorkflow(db, result.id);
    expect(fetched?.name).toBe('svc test wf');
    expect(fetched?.status).toBe('draft');
    expect(fetched?.createdBy).toBe('user_test');
    expect(fetched?.version).toBe(1);
  });

  it('updates only the provided fields', async () => {
    const { id } = await createWorkflow(db, { name: 'before update' }, 'user_test');
    const result = await updateWorkflow(db, id, { name: 'after update' });
    expect(result).toEqual({ id });

    const fetched = await getWorkflow(db, id);
    expect(fetched?.name).toBe('after update');
    expect(fetched?.status).toBe('draft'); // unchanged
  });

  it('soft-deletes — getWorkflow returns null after delete', async () => {
    const { id } = await createWorkflow(db, { name: 'to delete' }, 'user_test');
    await deleteWorkflow(db, id);
    expect(await getWorkflow(db, id)).toBeNull();
  });

  it('listWorkflows excludes soft-deleted rows', async () => {
    const toKeep = await createWorkflow(db, { name: 'keep' }, 'user_test');
    const toDrop = await createWorkflow(db, { name: 'drop' }, 'user_test');
    await deleteWorkflow(db, toDrop.id);

    const list = await listWorkflows(db, {});
    const ids = list.data.map((w) => w.id);
    expect(ids).toContain(toKeep.id);
    expect(ids).not.toContain(toDrop.id);
  });

  it('listWorkflows filters by search', async () => {
    await createWorkflow(db, { name: 'AlphaSearch wf' }, 'user_test');
    await createWorkflow(db, { name: 'OmegaSearch wf' }, 'user_test');

    const list = await listWorkflows(db, { search: 'AlphaSearch' });
    const names = list.data.map((w) => w.name);
    expect(names).toContain('AlphaSearch wf');
    expect(names).not.toContain('OmegaSearch wf');
  });

  it('getWorkflowStats returns count fields', async () => {
    const stats = await getWorkflowStats(db);
    expect(stats).toHaveProperty('totalWorkflows');
    expect(typeof stats.totalWorkflows).toBe('number');
  });
});
