/**
 * Workflow AI-builder service — drafts are regular `workflows` rows with
 * status='draft' and the chat/finalized state nested inside
 * `settings.builderState`, so no schema migration was needed.
 *
 * Ported from core-api/services/weldconnect-builder.ts.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
import type {
  WorkflowDraft,
  BuilderTriggerNode,
  BuilderActionNode,
  BuilderConditionNode,
} from '@weldsuite/core-api-client/schemas/weldconnect-builder';
import type {
  TriggerConfig,
  WorkflowStep,
  WorkflowSettings,
} from '@weldsuite/db/schema/workflows';

const BUILDER_TAG = 'ai-builder';

interface BuilderSettings extends WorkflowSettings {
  builderState?: {
    isBuilderDraft: boolean;
    chatHistory: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
    finalized: boolean;
  };
}

function rowToDraft(row: typeof schema.workflows.$inferSelect): WorkflowDraft {
  const triggerConfig = (row.triggers ?? [])[0] as TriggerConfig | undefined;
  const trigger: BuilderTriggerNode | null = triggerConfig
    ? {
        id: triggerConfig.id,
        kind: 'trigger',
        triggerType: triggerConfig.type as unknown as BuilderTriggerNode['triggerType'],
        label: triggerConfig.name,
        config: (triggerConfig.config ?? {}) as unknown as Record<string, unknown>,
      }
    : null;

  const steps = (row.steps ?? []) as WorkflowStep[];
  const builderSteps = steps.map((step): BuilderActionNode | BuilderConditionNode => {
    if (step.type === 'condition') {
      return {
        id: step.id,
        kind: 'condition',
        label: step.name,
        expression: (step.config?.expression as string) ?? '',
        branches: (step.config?.branches as Array<{ label: string; description?: string }>) ?? [],
      };
    }
    return {
      id: step.id,
      kind: 'action',
      actionType: step.type as BuilderActionNode['actionType'],
      label: step.name,
      description: step.description,
      config: (step.config ?? {}) as Record<string, unknown>,
    };
  });

  const settings = (row.settings ?? {}) as BuilderSettings;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    trigger,
    steps: builderSteps,
    finalized: settings.builderState?.finalized ?? false,
  };
}

export async function createBuilderDraft(db: Database, userId: string): Promise<WorkflowDraft> {
  const id = generateId('wf');
  const now = new Date();

  const initialSettings: BuilderSettings = {
    builderState: { isBuilderDraft: true, chatHistory: [], finalized: false },
  };

  await db.insert(schema.workflows).values({
    id,
    name: 'Untitled AI workflow',
    description: null,
    status: 'draft',
    triggers: [],
    steps: [],
    settings: initialSettings as any,
    tags: [BUILDER_TAG],
    createdBy: userId,
    version: 1,
    executionCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: now,
    updatedAt: now,
  });

  const [row] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, id)).limit(1);
  return rowToDraft(row!);
}

export async function getBuilderDraft(db: Database, id: string): Promise<WorkflowDraft | null> {
  const [row] = await db
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.id, id), isNull(schema.workflows.deletedAt)))
    .limit(1);
  return row ? rowToDraft(row) : null;
}

export async function getDraftChatHistory(
  db: Database,
  id: string,
): Promise<Array<{ role: 'user' | 'assistant' | 'system'; content: string }>> {
  const [row] = await db
    .select({ settings: schema.workflows.settings })
    .from(schema.workflows)
    .where(and(eq(schema.workflows.id, id), isNull(schema.workflows.deletedAt)))
    .limit(1);
  if (!row) return [];
  const settings = (row.settings ?? {}) as BuilderSettings;
  return settings.builderState?.chatHistory ?? [];
}

export async function finalizeBuilderDraft(
  db: Database,
  id: string,
  data: { name?: string; description?: string },
): Promise<WorkflowDraft | null> {
  const [row] = await db
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.id, id), isNull(schema.workflows.deletedAt)))
    .limit(1);
  if (!row) return null;

  const settings = (row.settings ?? {}) as BuilderSettings;
  const next: BuilderSettings = {
    ...settings,
    builderState: {
      isBuilderDraft: settings.builderState?.isBuilderDraft ?? true,
      chatHistory: settings.builderState?.chatHistory ?? [],
      finalized: true,
    },
  };

  const update: Record<string, unknown> = { settings: next, updatedAt: new Date() };
  if (data.name) update.name = data.name;
  if (data.description !== undefined) update.description = data.description;

  await db.update(schema.workflows).set(update).where(eq(schema.workflows.id, id));
  return getBuilderDraft(db, id);
}
