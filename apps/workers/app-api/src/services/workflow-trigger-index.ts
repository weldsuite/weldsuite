/**
 * Sync denormalized `workflow_trigger_index` rows from embedded
 * `workflows.triggers` JSONB. Called after create/update/status/delete.
 */

import { eq } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
import { atomically } from '../lib/atomically';
import { isMissingTable } from '../lib/pg-errors';

const { workflowTriggerIndex } = schema;

type TriggerLike = {
  id?: string;
  type?: string;
  isEnabled?: boolean;
  entityType?: string;
  eventType?: string;
  provider?: string;
  event?: string;
  integrationId?: string;
  filters?: Array<{ field: string; operator: string; value: unknown }>;
  config?: {
    type?: string;
    entityType?: string;
    eventType?: string;
    provider?: string;
    event?: string;
    integrationId?: string;
    sourceWorkflowId?: string;
    filters?: Array<{ field: string; operator: string; value: unknown }>;
  };
};

function asTriggers(raw: unknown): TriggerLike[] {
  return Array.isArray(raw) ? (raw as TriggerLike[]) : [];
}

function buildIndexRows(workflowId: string, triggers: unknown) {
  const now = new Date();
  return asTriggers(triggers)
    .filter((t) => t.id && t.type && t.isEnabled !== false)
    .map((t) => {
      const cfg = t.config ?? {};
      const category = (t.type ?? cfg.type ?? 'manual') as typeof workflowTriggerIndex.$inferInsert.category;
      return {
        id: generateId('wti'),
        createdAt: now,
        updatedAt: now,
        workflowId,
        triggerId: t.id!,
        category,
        isEnabled: t.isEnabled !== false,
        entityType: t.entityType ?? cfg.entityType ?? null,
        eventType: t.eventType ?? cfg.eventType ?? null,
        provider: t.provider ?? cfg.provider ?? null,
        integrationEvent: t.event ?? cfg.event ?? null,
        integrationId: t.integrationId ?? cfg.integrationId ?? null,
        sourceWorkflowId: cfg.sourceWorkflowId ?? null,
        filters: t.filters ?? cfg.filters ?? null,
      };
    });
}

export async function syncWorkflowTriggerIndex(
  db: Database,
  workflowId: string,
  triggers: unknown,
  opts: { workflowActive: boolean },
): Promise<void> {
  try {
    const rows = opts.workflowActive ? buildIndexRows(workflowId, triggers) : [];

    await atomically(db, (handle) => {
      const statements: unknown[] = [
        handle.delete(workflowTriggerIndex).where(eq(workflowTriggerIndex.workflowId, workflowId)),
      ];
      if (rows.length > 0) {
        statements.push(handle.insert(workflowTriggerIndex).values(rows));
      }
      return statements;
    });
  } catch (err) {
    if (isMissingTable(err)) {
      console.warn('[workflow-trigger-index] sync skipped: table not migrated yet');
      return;
    }
    throw err;
  }
}

export async function clearWorkflowTriggerIndex(db: Database, workflowId: string): Promise<void> {
  try {
    await db.delete(workflowTriggerIndex).where(eq(workflowTriggerIndex.workflowId, workflowId));
  } catch (err) {
    if (isMissingTable(err)) {
      console.warn('[workflow-trigger-index] clear skipped: table not migrated yet');
      return;
    }
    throw err;
  }
}
