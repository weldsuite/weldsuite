/**
 * ImportTasksWorkflow — Cloudflare Workflow
 *
 * Processes task-import jobs in 500-row batches. Reads the parsed JSON payload
 * from R2 (key set on the taskImportJobs row), runs each batch inside its own
 * `step.do` so retries don't reprocess earlier batches, and writes progress +
 * error aggregates back to the taskImportJobs row.
 *
 * Triggered by `POST /api/projects/:projectId/tasks/import-jobs` via
 * `env.IMPORT_TASKS.create({ id: jobId, params })` (routes/projects).
 *
 * Ported from apps/api-worker/src/workflows/import-tasks.ts (W4 legacy-worker
 * phase-out). Hosted in app-api under the NEW workflow names
 * `import-tasks-v2[-dev/-test/-preview]`. Note: api-worker declared the
 * binding + class but its dispatching route had already been deleted — the
 * dispatch surface is rebuilt in app-api's routes/projects.
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq, and, isNull, inArray, sql } from 'drizzle-orm';
import type { Env } from '../types';
import { getTenantDbForWorkspace, schema, type Database } from '../db';
import type { TaskImportError } from '@weldsuite/db';
import { generateId } from '../lib/id';
import { allocateTaskNumbers } from '../services/task-numbering';

// ── Types ────────────────────────────────────────────────────────────────

export interface ImportTasksParams {
  jobId: string;
  workspaceId: string; // clerkOrgId
  userId: string;
  projectId: string;
  r2Key: string;
}

interface TaskRow {
  key?: string; // External code/identifier — used for upsert lookup
  title?: string;
  description?: string;
  status?: string;
  stageName?: string; // Resolved to stageId by name match
  priority?: string;
  type?: string;
  assigneeEmail?: string; // Resolved to userId by email match
  startDate?: string;
  dueDate?: string;
  estimatedHours?: string;
  tags?: string[] | string;
  labels?: string[] | string;
}

interface BatchResult {
  imported: number;
  updated: number;
  failed: number;
  errors: TaskImportError[];
}

const BATCH_SIZE = 500;
const VALID_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'testing', 'done', 'cancelled'];
const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low', 'none'];
const VALID_TYPES = ['task', 'bug', 'story', 'epic', 'feature', 'improvement', 'subtask'];

// ── Helpers ──────────────────────────────────────────────────────────────

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(String(value).trim());
  return isNaN(d.getTime()) ? null : d;
}

function normalizeListField(value: string[] | string | undefined): string[] | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    const arr = value.filter((v): v is string => !!v && typeof v === 'string');
    return arr.length > 0 ? arr : null;
  }
  if (typeof value === 'string') {
    const arr = value.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
    return arr.length > 0 ? arr : null;
  }
  return null;
}

function normalizeTask(
  row: TaskRow,
  ctx: {
    stageMap: Map<string, { id: string; systemStatus: string }>;
    memberMap: Map<string, string>; // email → userId
  },
): {
  values: Record<string, any>;
  primaryAssigneeId: string | null;
  assigneeIds: string[];
} {
  const title = row.title ? String(row.title).trim() : '';

  let status = row.status ? String(row.status).toLowerCase().trim().replace(/[\s-]/g, '_') : 'todo';
  if (!VALID_STATUSES.includes(status)) status = 'todo';

  let priority = row.priority ? String(row.priority).toLowerCase().trim() : 'medium';
  if (!VALID_PRIORITIES.includes(priority)) priority = 'medium';

  let type = row.type ? String(row.type).toLowerCase().trim() : 'task';
  if (!VALID_TYPES.includes(type)) type = 'task';

  // Resolve stageId by case-insensitive name match; if found, derive status
  let stageId: string | null = null;
  if (row.stageName) {
    const stage = ctx.stageMap.get(String(row.stageName).toLowerCase().trim());
    if (stage) {
      stageId = stage.id;
      status = stage.systemStatus;
    }
  }

  // Resolve assignee by email
  let primaryAssigneeId: string | null = null;
  const assigneeIds: string[] = [];
  if (row.assigneeEmail) {
    const email = String(row.assigneeEmail).toLowerCase().trim();
    const userId = ctx.memberMap.get(email);
    if (userId) {
      primaryAssigneeId = userId;
      assigneeIds.push(userId);
    }
  }

  const values: Record<string, any> = {
    title,
    description: row.description ? String(row.description).trim() : null,
    status,
    stageId,
    priority,
    type,
    assigneeId: primaryAssigneeId,
    assigneeIds: assigneeIds.length > 0 ? assigneeIds : null,
    startDate: parseDate(row.startDate),
    dueDate: parseDate(row.dueDate),
    estimatedHours: row.estimatedHours ? String(row.estimatedHours).trim() : null,
    tags: normalizeListField(row.tags),
    labels: normalizeListField(row.labels),
  };

  return { values, primaryAssigneeId, assigneeIds };
}

async function loadResolutionMaps(db: Database, projectId: string) {
  const { projectPipelineStages, workspaceMembers } = schema;

  const stages = await db
    .select({
      id: projectPipelineStages.id,
      name: projectPipelineStages.name,
      systemStatus: projectPipelineStages.systemStatus,
    })
    .from(projectPipelineStages)
    .where(
      and(
        eq(projectPipelineStages.projectId, projectId),
        isNull(projectPipelineStages.deletedAt),
      ),
    );

  const stageMap = new Map<string, { id: string; systemStatus: string }>();
  for (const s of stages) {
    stageMap.set(s.name.toLowerCase().trim(), { id: s.id, systemStatus: s.systemStatus });
  }

  const members = await db
    .select({
      userId: workspaceMembers.userId,
      email: workspaceMembers.email,
    })
    .from(workspaceMembers)
    .where(isNull(workspaceMembers.deletedAt));

  const memberMap = new Map<string, string>();
  for (const m of members) {
    if (m.email) memberMap.set(m.email.toLowerCase().trim(), m.userId);
  }

  return { stageMap, memberMap };
}

async function processBatch(
  db: Database,
  batch: TaskRow[],
  ctx: {
    projectId: string;
    userId: string;
    startIndex: number;
    stageMap: Map<string, { id: string; systemStatus: string }>;
    memberMap: Map<string, string>;
    nextPositionRef: { value: number };
  },
): Promise<BatchResult> {
  const { tasks } = schema;
  const now = new Date();
  const result: BatchResult = { imported: 0, updated: 0, failed: 0, errors: [] };

  // Partition by key (upsert candidates) vs new inserts
  const upsertCandidates: { row: TaskRow; rowNum: number; title: string; key: string }[] = [];
  const insertCandidates: { row: TaskRow; rowNum: number; title: string }[] = [];

  for (let i = 0; i < batch.length; i++) {
    const row = batch[i]!;
    const rowNum = ctx.startIndex + i + 1;
    const title = row.title ? String(row.title).trim() : '';

    if (!title) {
      result.errors.push({ row: rowNum, title: '(missing)', error: 'Title is required' });
      result.failed++;
      continue;
    }

    if (row.key) {
      upsertCandidates.push({ row, rowNum, title, key: String(row.key).trim() });
    } else {
      insertCandidates.push({ row, rowNum, title });
    }
  }

  // ── Path 1: Key-based upserts ────────────────────────────────────────
  if (upsertCandidates.length > 0) {
    const keys = upsertCandidates.map((c) => c.key);
    const existing = await db
      .select({ id: tasks.id, key: tasks.key })
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, ctx.projectId),
          inArray(tasks.key, keys),
          isNull(tasks.deletedAt),
        ),
      );
    const existingByKey = new Map(existing.map((t) => [t.key as string, t.id]));

    // Pre-allocate a block of numbers for the candidates that will be new inserts
    // (existing keys are updates and keep their current number).
    const insertCount = upsertCandidates.filter((c) => !existingByKey.has(c.key)).length;
    const numberPool = await allocateTaskNumbers(db, insertCount);
    let numberCursor = 0;

    for (const candidate of upsertCandidates) {
      try {
        const { values } = normalizeTask(candidate.row, ctx);
        const existingId = existingByKey.get(candidate.key);

        if (existingId) {
          await db
            .update(tasks)
            .set({ ...values, updatedAt: now })
            .where(eq(tasks.id, existingId));
          result.updated++;
        } else {
          const id = generateId('task');
          await db.insert(tasks).values({
            id,
            number: numberPool[numberCursor++],
            projectId: ctx.projectId,
            key: candidate.key,
            ...values,
            reporterId: ctx.userId,
            isBillable: true,
            position: ctx.nextPositionRef.value++,
            progress: '0',
            createdAt: now,
            updatedAt: now,
          } as any);
          result.imported++;
        }
      } catch (err: any) {
        result.errors.push({
          row: candidate.rowNum,
          title: candidate.title,
          error: err?.message || 'Database error',
        });
        result.failed++;
      }
    }
  }

  // ── Path 2: New inserts ──────────────────────────────────────────────
  if (insertCandidates.length > 0) {
    // Allocate a contiguous block of task numbers in one atomic bump.
    const numbers = await allocateTaskNumbers(db, insertCandidates.length);
    const toInsert: Array<typeof tasks.$inferInsert> = [];
    for (let idx = 0; idx < insertCandidates.length; idx++) {
      const c = insertCandidates[idx];
      const { values } = normalizeTask(c.row, ctx);
      toInsert.push({
        id: generateId('task'),
        number: numbers[idx],
        projectId: ctx.projectId,
        ...values,
        reporterId: ctx.userId,
        isBillable: true,
        position: ctx.nextPositionRef.value++,
        progress: '0',
        createdAt: now,
        updatedAt: now,
      } as any);
    }

    const CHUNK = 100;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const chunk = toInsert.slice(i, i + CHUNK);
      try {
        await db.insert(tasks).values(chunk);
        result.imported += chunk.length;
      } catch (err: any) {
        // Fall back to per-row insert to isolate the failing row
        for (const item of chunk) {
          try {
            await db.insert(tasks).values(item);
            result.imported++;
          } catch (rowErr: any) {
            result.errors.push({
              row: 0,
              title: (item as any).title || '(unknown)',
              error: rowErr?.message || 'Database error',
            });
            result.failed++;
          }
        }
      }
    }
  }

  return result;
}

// ── Workflow ─────────────────────────────────────────────────────────────

export class ImportTasksWorkflow extends WorkflowEntrypoint<Env, ImportTasksParams> {
  async run(event: WorkflowEvent<ImportTasksParams>, step: WorkflowStep) {
    const { jobId, workspaceId, userId, projectId, r2Key } = event.payload;
    const { taskImportJobs, tasks } = schema;

    // Step 1: Load payload from R2
    const rows = await step.do(
      'load-payload',
      { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } },
      async () => {
        if (!this.env.STORAGE) throw new Error('R2 STORAGE binding missing');
        const obj = await this.env.STORAGE.get(r2Key);
        if (!obj) throw new Error(`Payload missing from R2: ${r2Key}`);
        const text = await obj.text();
        return JSON.parse(text) as TaskRow[];
      },
    );

    if (!Array.isArray(rows)) {
      throw new Error('Invalid payload — expected array');
    }

    // Step 2: Mark running + write total
    await step.do('mark-running', async () => {
      const db = await getTenantDbForWorkspace(this.env, workspaceId);
      await db
        .update(taskImportJobs)
        .set({ status: 'running', total: rows.length, updatedAt: new Date() })
        .where(eq(taskImportJobs.id, jobId));
    });

    // Step 3: Resolve maps (stages, members) and starting position once
    const setup = await step.do('load-resolution-maps', async () => {
      const db = await getTenantDbForWorkspace(this.env, workspaceId);
      const maps = await loadResolutionMaps(db, projectId);
      const positionResult = await db
        .select({ maxPosition: sql<number>`coalesce(max(${tasks.position}), 0)::int` })
        .from(tasks)
        .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)));
      const startPosition = (positionResult[0]?.maxPosition || 0) + 1;
      return {
        stages: Array.from(maps.stageMap.entries()),
        members: Array.from(maps.memberMap.entries()),
        startPosition,
      };
    });

    const stageMap = new Map(setup.stages);
    const memberMap = new Map(setup.members);
    const nextPositionRef = { value: setup.startPosition };

    // Step 4: Process in 500-row batches; each batch is its own step
    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const batch = rows.slice(offset, offset + BATCH_SIZE);
      await step.do(
        `process-batch-${offset}`,
        { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' } },
        async () => {
          const db = await getTenantDbForWorkspace(this.env, workspaceId);
          const r = await processBatch(db, batch, {
            projectId,
            userId,
            startIndex: offset,
            stageMap,
            memberMap,
            nextPositionRef,
          });
          const errSlice = r.errors.slice(0, 50);
          await db
            .update(taskImportJobs)
            .set({
              processed: sql`${taskImportJobs.processed} + ${batch.length}`,
              imported: sql`${taskImportJobs.imported} + ${r.imported}`,
              updated: sql`${taskImportJobs.updated} + ${r.updated}`,
              failed: sql`${taskImportJobs.failed} + ${r.failed}`,
              errors: sql`COALESCE(${taskImportJobs.errors}, '[]'::jsonb) || ${JSON.stringify(errSlice)}::jsonb`,
              updatedAt: new Date(),
            })
            .where(eq(taskImportJobs.id, jobId));
        },
      );
    }

    // Step 5: Finalize and clean up R2
    await step.do('finalize', async () => {
      const db = await getTenantDbForWorkspace(this.env, workspaceId);
      await db
        .update(taskImportJobs)
        .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
        .where(eq(taskImportJobs.id, jobId));
      try {
        if (this.env.STORAGE) await this.env.STORAGE.delete(r2Key);
      } catch {
        // Non-fatal
      }
    });
  }
}
