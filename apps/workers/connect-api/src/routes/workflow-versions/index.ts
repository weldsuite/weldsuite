/**
 * Workflow version history routes — flat /api/workflow-versions/* surface.
 *
 * `GET /` and `GET /:id` are read-only browsing of the history captured by
 * `snapshotWorkflowVersion` (see routes/workflows/index.ts and
 * services/workflow-versions.ts for the snapshot policy). `POST /:id/restore`
 * is the only write: it re-applies a past snapshot's name/triggers/steps/
 * settings through the SAME `updateWorkflow` path a normal save takes, so
 * schedule and webhook triggers get resynced exactly like a save would, then
 * snapshots the result as a new version (`reason: 'restored'`).
 *
 * Permissions: workflows:read | workflows:update (restore is a kind of update).
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import * as versions from '../../services/workflow-versions';
import * as workflowsService from '../../services/workflows';
import { rejectUnsupportedActivation, scheduleSyncFor, webhookSyncFor } from '../workflows';
import { syncWorkflowPollIndex } from '../../lib/tenant-work-index';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('workflows:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  try {
    const result = await versions.listWorkflowVersions(db, {
      workflowId: q.workflowId,
      cursor: q.cursor,
      limit: q.limit ? parseInt(q.limit, 10) : 25,
    });
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[connect-api/workflow-versions] list failed:', err);
    return error.internal(c, 'Failed to list workflow versions');
  }
});

app.get('/:id', requirePermission('workflows:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await versions.getWorkflowVersion(db, id);
    if (!row) return error.notFound(c, 'Workflow version', id);
    return success(c, row);
  } catch (err) {
    console.error('[connect-api/workflow-versions] get failed:', err);
    return error.internal(c, 'Failed to fetch workflow version');
  }
});

app.post('/:id/restore', requirePermission('workflows:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const snapshot = await versions.getWorkflowVersion(db, id);
    if (!snapshot) return error.notFound(c, 'Workflow version', id);

    const existing = await workflowsService.getWorkflow(db, snapshot.workflowId);
    if (!existing) return error.notFound(c, 'Workflow', snapshot.workflowId);

    // Restoring never changes the workflow's current status — only its
    // content. If it's active, that content still has to pass the gate.
    if (existing.status === 'active') {
      const rejection = rejectUnsupportedActivation(c, {
        triggers: snapshot.triggers,
        steps: snapshot.steps,
        tags: existing.tags,
      });
      if (rejection) return rejection;
    }

    const data = { name: snapshot.name, triggers: snapshot.triggers, steps: snapshot.steps, settings: snapshot.settings };
    const result = await workflowsService.updateWorkflow(db, snapshot.workflowId, data, scheduleSyncFor(c), webhookSyncFor(c));
    if (!result) return error.notFound(c, 'Workflow', snapshot.workflowId);
    await syncWorkflowPollIndex(c.env, db, c.get('workspaceId'));

    const after = await workflowsService.getWorkflow(db, snapshot.workflowId);
    const newVersion = await versions.snapshotWorkflowVersion(db, {
      workflowId: snapshot.workflowId,
      name: after?.name ?? snapshot.name,
      status: after?.status ?? existing.status,
      triggers: after?.triggers ?? snapshot.triggers,
      steps: after?.steps ?? snapshot.steps,
      settings: after?.settings ?? snapshot.settings,
      createdBy: c.get('userId'),
      reason: 'restored',
      restoredFromVersion: snapshot.version,
      note: `Restored from version ${snapshot.version}`,
    });

    publishEntityEvent({
      c,
      entityType: 'workflow',
      entityId: snapshot.workflowId,
      action: 'updated',
      data: { id: snapshot.workflowId, name: after?.name ?? snapshot.name, status: after?.status ?? null },
    });

    return success(c, { workflowId: snapshot.workflowId, version: newVersion.version, restoredFromVersion: snapshot.version });
  } catch (err) {
    console.error('[connect-api/workflow-versions] restore failed:', err);
    return error.internal(c, 'Failed to restore workflow version');
  }
});

export const workflowVersionsRoutes = app;
