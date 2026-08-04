/**
 * Sync denormalized `workflow_trigger_index` rows from embedded
 * `workflows.triggers` JSONB. Called after create/update/status/delete.
 */

import { eq } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

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

export async function syncWorkflowTriggerIndex(
  db: Database,
  workflowId: string,
  triggers: unknown,
  opts: { workflowActive: boolean },
): Promise<void> {
  try {
    await db.delete(workflowTriggerIndex).where(eq(workflowTriggerIndex.workflowId, workflowId));

    if (!opts.workflowActive) return;

    const now = new Date();
    const rows = asTriggers(triggers)
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

    if (rows.length > 0) {
      await db.insert(workflowTriggerIndex).values(rows);
    }
  } catch (err) {
    // Table may be absent until the greenfield tenant migration is applied.
    console.warn('[workflow-trigger-index] sync skipped:', err);
  }
}

export async function clearWorkflowTriggerIndex(db: Database, workflowId: string): Promise<void> {
  try {
    await db.delete(workflowTriggerIndex).where(eq(workflowTriggerIndex.workflowId, workflowId));
  } catch (err) {
    console.warn('[workflow-trigger-index] clear skipped:', err);
  }
}
