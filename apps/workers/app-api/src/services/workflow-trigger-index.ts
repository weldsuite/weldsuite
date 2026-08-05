/**
 * Sync denormalized `workflow_trigger_index` rows from embedded
 * `workflows.triggers` JSONB.
 *
 * Callers that also mutate the workflow row should pass those statements via
 * `withStatements` so workflow + index writes commit as one batch.
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

function buildIndexStatements(
  handle: Database,
  workflowId: string,
  triggers: unknown,
  opts: { workflowActive: boolean },
): unknown[] {
  const rows = opts.workflowActive ? buildIndexRows(workflowId, triggers) : [];
  const statements: unknown[] = [
    handle.delete(workflowTriggerIndex).where(eq(workflowTriggerIndex.workflowId, workflowId)),
  ];
  if (rows.length > 0) {
    statements.push(handle.insert(workflowTriggerIndex).values(rows));
  }
  return statements;
}

export async function syncWorkflowTriggerIndex(
  db: Database,
  workflowId: string,
  triggers: unknown,
  opts: {
    workflowActive: boolean;
    /** Workflow (or other) statements to run in the same atomic batch. */
    withStatements?: (handle: Database) => unknown[];
  },
): Promise<void> {
  const preceding = opts.withStatements;

  try {
    await atomically(db, (handle) => [
      ...(preceding ? preceding(handle) : []),
      ...buildIndexStatements(handle, workflowId, triggers, opts),
    ]);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    console.warn('[workflow-trigger-index] sync skipped: table not migrated yet');
    // Migration not applied — persist the workflow write alone so CRUD still works.
    if (preceding) {
      await atomically(db, (handle) => preceding(handle));
    }
  }
}

export async function clearWorkflowTriggerIndex(
  db: Database,
  workflowId: string,
  opts?: {
    withStatements?: (handle: Database) => unknown[];
  },
): Promise<void> {
  const preceding = opts?.withStatements;

  try {
    await atomically(db, (handle) => [
      ...(preceding ? preceding(handle) : []),
      handle.delete(workflowTriggerIndex).where(eq(workflowTriggerIndex.workflowId, workflowId)),
    ]);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    console.warn('[workflow-trigger-index] clear skipped: table not migrated yet');
    if (preceding) {
      await atomically(db, (handle) => preceding(handle));
    }
  }
}
