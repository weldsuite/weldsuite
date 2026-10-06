/**
 * Tests for workflow-webhook provisioning (services/workflow-webhook-sync.ts):
 * saving a workflow with a webhook trigger must create a `workflow_webhooks`
 * row (+ register it) without the caller doing anything extra, mirroring
 * workflow-schedule-sync.ts for `schedule` triggers.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { createPgliteDb, createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { syncWorkflowWebhooks, type WebhookSyncContext } from './workflow-webhook-sync';
import { resolveWebhookWorkspace } from './workflow-webhook-registry';

const { workflowWebhooks } = schema;

let db: Database;
let masterDb: MasterDatabase;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
}, 60_000);

let seq = 0;
const nextId = (prefix: string) => `${prefix}_t${++seq}`;

function ctx(workspaceId = 'org_1'): WebhookSyncContext {
  return {
    registry: () => ({ masterDb }),
    workspaceId,
    publicApiBase: 'https://connect-api-test.weldsuite.org',
  };
}

async function webhookRowsFor(workflowId: string) {
  return db
    .select()
    .from(workflowWebhooks)
    .where(and(eq(workflowWebhooks.workflowId, workflowId), isNull(workflowWebhooks.deletedAt)));
}

describe('syncWorkflowWebhooks', () => {
  it('provisions a workflow_webhooks row for a new enabled webhook trigger and registers it', async () => {
    const workflowId = nextId('wf');
    const triggerId = 'trigger-webhook-1';

    await syncWorkflowWebhooks(db, ctx(), {
      workflowId,
      previousTriggers: [],
      nextTriggers: [{ id: triggerId, type: 'webhook', name: 'Order received' }],
    });

    const rows = await webhookRowsFor(workflowId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.triggerId).toBe(triggerId);
    expect(row.name).toBe('Order received');
    expect(row.isEnabled).toBe(true);
    expect(row.validateSignature).toBe(false);
    expect(row.secret).toBeTruthy();
    expect(row.url).toBe(`/api/workflows/webhook/${row.id}`);
    expect(row.externalUrl).toBe(`https://connect-api-test.weldsuite.org${row.url}`);

    expect(await resolveWebhookWorkspace({ masterDb }, row.id)).toBe('org_1');
  });

  it('is a no-op when there is no webhook trigger in either trigger list', async () => {
    const workflowId = nextId('wf');
    await syncWorkflowWebhooks(db, ctx(), {
      workflowId,
      previousTriggers: [],
      nextTriggers: [{ id: 't', type: 'schedule', cronExpression: '0 9 * * *' }],
    });
    expect(await webhookRowsFor(workflowId)).toHaveLength(0);
  });

  it('does not create a second row on a no-op save (idempotent)', async () => {
    const workflowId = nextId('wf');
    const triggers = [{ id: 'trg-x', type: 'webhook', name: 'Hook' }];
    await syncWorkflowWebhooks(db, ctx(), { workflowId, previousTriggers: [], nextTriggers: triggers });
    await syncWorkflowWebhooks(db, ctx(), { workflowId, previousTriggers: triggers, nextTriggers: triggers });
    expect(await webhookRowsFor(workflowId)).toHaveLength(1);
  });

  it('disables (not deletes) the row when its trigger is disabled, and keeps the secret', async () => {
    const workflowId = nextId('wf');
    const triggerId = 'trg-disable';
    const enabled = [{ id: triggerId, type: 'webhook' }];
    await syncWorkflowWebhooks(db, ctx(), { workflowId, previousTriggers: [], nextTriggers: enabled });
    const [before] = await webhookRowsFor(workflowId);

    const disabled = [{ id: triggerId, type: 'webhook', isEnabled: false }];
    await syncWorkflowWebhooks(db, ctx(), { workflowId, previousTriggers: enabled, nextTriggers: disabled });

    const rows = await webhookRowsFor(workflowId);
    expect(rows).toHaveLength(1); // still present, not soft-deleted
    expect(rows[0].isEnabled).toBe(false);
    expect(rows[0].secret).toBe(before.secret);

    // Re-enabling brings it back without issuing a new id/secret.
    await syncWorkflowWebhooks(db, ctx(), { workflowId, previousTriggers: disabled, nextTriggers: enabled });
    const reEnabled = await webhookRowsFor(workflowId);
    expect(reEnabled[0].id).toBe(before.id);
    expect(reEnabled[0].isEnabled).toBe(true);
    expect(reEnabled[0].secret).toBe(before.secret);
  });

  it('soft-deletes the row AND deregisters it when the trigger is removed entirely', async () => {
    const workflowId = nextId('wf');
    const triggerId = 'trg-remove';
    const withTrigger = [{ id: triggerId, type: 'webhook' }];
    await syncWorkflowWebhooks(db, ctx(), { workflowId, previousTriggers: [], nextTriggers: withTrigger });
    const [before] = await webhookRowsFor(workflowId);
    expect(await resolveWebhookWorkspace({ masterDb }, before.id)).toBe('org_1');

    await syncWorkflowWebhooks(db, ctx(), { workflowId, previousTriggers: withTrigger, nextTriggers: [] });

    expect(await webhookRowsFor(workflowId)).toHaveLength(0);
    const [deleted] = await db.select().from(workflowWebhooks).where(eq(workflowWebhooks.id, before.id));
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.isEnabled).toBe(false);
    expect(await resolveWebhookWorkspace({ masterDb }, before.id)).toBeNull();
  });

  it('is a no-op when no sync context is given (e.g. a worker without the registry wired up)', async () => {
    const workflowId = nextId('wf');
    await syncWorkflowWebhooks(db, undefined, {
      workflowId,
      previousTriggers: [],
      nextTriggers: [{ id: 't', type: 'webhook' }],
    });
    expect(await webhookRowsFor(workflowId)).toHaveLength(0);
  });
});
