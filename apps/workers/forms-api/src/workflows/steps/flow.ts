/**
 * ProcessResponse step: WeldFlow (ADR FORMS-006). Per enabled `flow`
 * integration, as the member who set it up: a task in the chosen project (or a
 * personal task of the assignee) with a title and description from recall
 * templates, an assignee, a due date from a date question, labels, and the
 * response's uploads attached as files of the task.
 *
 * Written through `@weldsuite/flow-domain/tasks` (numbering, stage, position),
 * the same writer flow-api and WeldConnect use. The task is remembered on the
 * action row as soon as it exists, so a retry after a later failure (the
 * attachments) goes on with the same task; an edit of the response leaves it
 * as it is.
 */

import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { flowIntegrationConfigSchema } from '@weldsuite/app-api-client/schemas/weldforms';
import { createFile } from '@weldsuite/core-domain/files';
import { resolveProjectAccess } from '@weldsuite/flow-domain/project-access';
import { taskAnalyticsPayload } from '@weldsuite/flow-domain/analytics-payload';
import { createTask } from '@weldsuite/flow-domain/tasks';
import { CreatorForbiddenError, loadCreatorAccess, type CreatorAccess } from '../../services/creator-access';
import { answerText, emitRecordEvent, readResponseFile, recordedEntity, rememberEntity, renderTemplate, safeFileName } from '../../services/integration-support';
import type { IntegrationStep, ProcessContext, StepResult } from './types';

const { files, tasks } = schema;
type Integration = Parameters<IntegrationStep['run']>[1];

/** The response's uploads as files of the task, each copied once (a retry finds the copies it made). */
async function attachFiles(ctx: ProcessContext, taskId: string, userId: string): Promise<void> {
  const made = await ctx.db
    .select({ source: sql<string>`${files.metadata}->>'formResponseFileId'` })
    .from(files)
    .where(and(eq(files.entityType, 'task'), eq(files.entityId, taskId)));
  const done = new Set(made.map((m) => m.source));
  for (const file of ctx.files) {
    if (done.has(file.id)) continue;
    const body = await readResponseFile(ctx.env, file);
    if (!body) continue;
    const name = safeFileName(file.name);
    // A copy of its own, under the task: deleting the response never breaks the task, nor the other way round.
    const key = `workspaces/${ctx.params.clerkOrgId}/tasks/${taskId}/${crypto.randomUUID()}/${name}`;
    await ctx.env.PRIVATE_STORAGE.put(key, body, { httpMetadata: { contentType: file.contentType } });
    await createFile(ctx.db, {
      fileName: file.name,
      mimeType: file.contentType,
      fileSize: file.sizeBytes,
      storagePath: key,
      fileKey: key,
      bucket: 'private',
      entityType: 'task',
      entityId: taskId,
      uploadedById: userId,
      metadata: { formResponseFileId: file.id, formId: ctx.form.id, responseId: ctx.response.id },
    });
  }
}

async function taskExists(db: Database, id: string): Promise<boolean> {
  const [row] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).limit(1);
  return Boolean(row);
}

type FlowConfig = ReturnType<typeof flowIntegrationConfigSchema.parse>;

/** The task an earlier run made, when it still exists. */
async function recordedTask(ctx: ProcessContext, integration: Integration): Promise<string | null> {
  const recorded = await recordedEntity(ctx.db, ctx, integration);
  return recorded?.entityType === 'task' && (await taskExists(ctx.db, recorded.entityId)) ? recorded.entityId : null;
}

/** What the task is made with: title and description from the templates, the assignee, a due date from the date question, labels. */
function taskInput(ctx: ProcessContext, config: FlowConfig, userId: string): Parameters<typeof createTask>[1] {
  const template = { env: ctx.env, form: ctx.form, response: ctx.response, definition: ctx.definition };
  const title = renderTemplate(config.title, template).trim() || `${ctx.form.title} #${ctx.response.number ?? ''}`.trim();
  const description = renderTemplate(config.description, template).trim();
  const due = config.dueDateFieldId ? answerText(ctx.definition, ctx.response, config.dueDateFieldId) : '';
  // A personal task belongs to someone: the assignee, else the member who set the integration up.
  const assigneeId = config.assigneeUserId ?? (config.projectId ? undefined : userId);
  return {
    title: title.slice(0, 500),
    description: description || undefined,
    assigneeId,
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : undefined,
    labels: config.labels.length ? config.labels : undefined,
    sourceType: 'form_response',
    sourceId: ctx.response.id,
  };
}

/** A new task, as the member who set the integration up: their right to create tasks and to write to the project are checked first. */
async function createFlowTask(ctx: ProcessContext, integration: Integration, config: FlowConfig, access: CreatorAccess): Promise<StepResult> {
  const userId = integration.createdByUserId;
  access.require('tasks:create', 'weldflow', 'create tasks');
  if (config.projectId) {
    const project = await resolveProjectAccess(ctx.db, userId, { scopeAll: access.can('projects:scope:all', 'weldflow') }, config.projectId);
    if (project.deleted) return { status: 'skipped', reason: 'The project of this integration no longer exists' };
    if (!project.canWrite) throw new CreatorForbiddenError('The member who set up this integration does not have write access to the project');
  }

  const { row } = await createTask(ctx.db, taskInput(ctx, config, userId), { projectId: config.projectId, userId });
  await rememberEntity(ctx.db, ctx, integration, 'task', row.id);
  await emitRecordEvent(ctx, integration, 'project_task', 'created', row.id, taskAnalyticsPayload(row as unknown as Record<string, unknown>, { projectId: config.projectId }) as unknown as Record<string, unknown>);
  if (config.attachFiles) await attachFiles(ctx, row.id, userId);
  return { status: 'done', entityType: 'task', entityId: row.id };
}

export async function runFlowStep(ctx: ProcessContext, integration: Integration): Promise<StepResult> {
  const parsed = flowIntegrationConfigSchema.safeParse(integration.config);
  if (!parsed.success) return { status: 'skipped', reason: 'The Flow integration is not set up correctly' };
  const config = parsed.data;
  const userId = integration.createdByUserId;

  try {
    const known = await recordedTask(ctx, integration);
    // An edited response leaves the task as the team found it.
    if (known && ctx.params.mode === 'update') return { status: 'done', entityType: 'task', entityId: known };

    const access = await loadCreatorAccess(ctx.db, ctx.env, userId);
    if (!known) return await createFlowTask(ctx, integration, config, access);
    // Resumed after a failure: only what is missing (the attachments) is still to do.
    if (config.attachFiles) await attachFiles(ctx, known, userId);
    return { status: 'done', entityType: 'task', entityId: known };
  } catch (err) {
    if (err instanceof CreatorForbiddenError) return { status: 'skipped', reason: err.message };
    throw err;
  }
}

export const flowStep: IntegrationStep = { type: 'integration', kind: 'flow', name: 'flow', run: runFlowStep };
