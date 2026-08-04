/**
 * Integration tests for workflow_trigger_index sync against pglite.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createWorkflow, updateWorkflowStatus, deleteWorkflow } from './workflows';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';

const { workflowTriggerIndex } = schema;

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('workflow trigger index sync', () => {
  it('indexes entity_event triggers when a workflow is activated', async () => {
    const triggers = [
      {
        id: 'trg_entity_1',
        type: 'entity_event',
        name: 'Company created',
        isEnabled: true,
        config: {
          type: 'entity_event',
          entityType: 'company',
          eventType: 'created',
        },
      },
      {
        id: 'trg_manual_1',
        type: 'manual',
        name: 'Manual',
        isEnabled: true,
        config: { type: 'manual' },
      },
    ];

    const { id } = await createWorkflow(
      db,
      { name: 'index sync wf', status: 'draft', triggers },
      'user_test',
    );

    // Draft — no index rows
    let rows = await db
      .select()
      .from(workflowTriggerIndex)
      .where(eq(workflowTriggerIndex.workflowId, id));
    expect(rows).toHaveLength(0);

    await updateWorkflowStatus(db, id, 'active');

    rows = await db
      .select()
      .from(workflowTriggerIndex)
      .where(eq(workflowTriggerIndex.workflowId, id));
    expect(rows).toHaveLength(2);

    const entityRow = rows.find((r) => r.triggerId === 'trg_entity_1');
    expect(entityRow?.category).toBe('entity_event');
    expect(entityRow?.entityType).toBe('company');
    expect(entityRow?.eventType).toBe('created');
    expect(entityRow?.isEnabled).toBe(true);

    await deleteWorkflow(db, id);
    rows = await db
      .select()
      .from(workflowTriggerIndex)
      .where(eq(workflowTriggerIndex.workflowId, id));
    expect(rows).toHaveLength(0);
  });
});
