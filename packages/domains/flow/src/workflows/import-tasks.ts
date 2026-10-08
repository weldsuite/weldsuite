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
 * phase-out). Hosted in flow-api under the workflow names
 * `import-tasks-v3[-dev]` (bound as IMPORT_TASKS and re-exported from
 * flow-api's src/index.ts). app-api keeps its old `import-tasks-v2*` names and
 * re-exports this class only while their in-flight instances drain
 * (docs/plans/app-api-module-split.md, "Workflows draining in app-api").
 * Note: api-worker declared the binding + class but its dispatching route had
 * already been deleted — the dispatch surface was rebuilt in routes/projects
 * (now in flow-api).
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq, and, isNull, inArray, sql } from 'drizzle-orm';
import type { DbEnv } from '@weldsuite/worker-kit/env';
import { getTenantDbForWorkspace, schema, type Database } from '@weldsuite/worker-kit/db';
import type { TaskImportError } from '@weldsuite/db/schema/task-import-jobs';
import { generateId } from '@weldsuite/worker-kit/id';
import { allocateTaskNumbers } from '../task-numbering';
import { asText } from '@weldsuite/text';

/**
 * The bindings the workflow reads: tenant DB resolution plus the R2 bucket
 * holding the parsed import payload. Any worker Env with them fits.
 */
export interface ImportTasksEnv extends DbEnv {
  /** R2 bucket holding the import job's JSON payload. */
  STORAGE?: R2Bucket;
}

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
  const d = new Date(asText(value).trim());
  return Number.isNaN(d.getTime()) ? null : d;
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

/** Lower-cases + trims a free-text value and falls back when it is empty or not one of `valid`. */
function normalizeEnum(
  raw: unknown,
  valid: string[],
  fallback: string,
  sanitize: (value: string) => string = (value) => value,
): string {
  if (!raw) return fallback;
  const value = sanitize(asText(raw).toLowerCase().trim());
  return valid.includes(value) ? value : fallback;
}

type StageMap = Map<string, { id: string; systemStatus: string }>;

function normalizeTask(
  row: TaskRow,
  ctx: {
    stageMap: StageMap;
    memberMap: Map<string, string>; // email → userId
  },
): {
  values: Record<string, any>;
  primaryAssigneeId: string | null;
  assigneeIds: string[];
} {
  const title = row.title ? String(row.title).trim() : '';

  let status = normalizeEnum(row.status, VALID_STATUSES, 'todo', (v) => v.replaceAll(/[\s-]/g, '_'));
  const priority = normalizeEnum(row.priority, VALID_PRIORITIES, 'medium');
  const type = normalizeEnum(row.type, VALID_TYPES, 'task');

  // Resolve stageId by case-insensitive name match; if found, derive status
  let stageId: string | null = null;
  const stage = row.stageName ? ctx.stageMap.get(String(row.stageName).toLowerCase().trim()) : undefined;
  if (stage) {
    stageId = stage.id;
    status = stage.systemStatus;
  }

  // Resolve assignee by email
  const primaryAssigneeId = row.assigneeEmail
    ? (ctx.memberMap.get(String(row.assigneeEmail).toLowerCase().trim()) || null)
    : null;
  const assigneeIds: string[] = primaryAssigneeId ? [primaryAssigneeId] : [];

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

interface BatchContext {
  projectId: string;
  userId: string;
  startIndex: number;
  stageMap: StageMap;
  memberMap: Map<string, string>;
  nextPositionRef: { value: number };
}

type UpsertCandidate = { row: TaskRow; rowNum: number; title: string; key: string };
type InsertCandidate = { row: TaskRow; rowNum: number; title: string };

/** Split rows into key-based upsert candidates and plain inserts; rows without a title fail. */
function partitionBatch(
  batch: TaskRow[],
  startIndex: number,
  result: BatchResult,
): { upsertCandidates: UpsertCandidate[]; insertCandidates: InsertCandidate[] } {
  const upsertCandidates: UpsertCandidate[] = [];
  const insertCandidates: InsertCandidate[] = [];

  for (let i = 0; i < batch.length; i++) {
    const row = batch[i]!;
    const rowNum = startIndex + i + 1;
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
  return { upsertCandidates, insertCandidates };
}

// ── Path 1: Key-based upserts ────────────────────────────────────────────
async function processUpserts(
  db: Database,
  upsertCandidates: UpsertCandidate[],
  ctx: BatchContext,
  now: Date,
  result: BatchResult,
): Promise<void> {
  const { tasks } = schema;
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

/** Inserts one chunk, falling back to per-row inserts to isolate a failing row. */
async function insertChunk(
  db: Database,
  chunk: Array<typeof schema.tasks.$inferInsert>,
  result: BatchResult,
): Promise<void> {
  const { tasks } = schema;
  try {
    await db.insert(tasks).values(chunk);
    result.imported += chunk.length;
    return;
  } catch {
    // Fall through to the per-row insert below
  }

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

// ── Path 2: New inserts ──────────────────────────────────────────────────
async function processInserts(
  db: Database,
  insertCandidates: InsertCandidate[],
  ctx: BatchContext,
  now: Date,
  result: BatchResult,
): Promise<void> {
  // Allocate a contiguous block of task numbers in one atomic bump.
  const numbers = await allocateTaskNumbers(db, insertCandidates.length);
  const toInsert: Array<typeof schema.tasks.$inferInsert> = [];
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
    await insertChunk(db, toInsert.slice(i, i + CHUNK), result);
  }
}

async function processBatch(
  db: Database,
  batch: TaskRow[],
  ctx: BatchContext,
): Promise<BatchResult> {
  const now = new Date();
  const result: BatchResult = { imported: 0, updated: 0, failed: 0, errors: [] };

  // Partition by key (upsert candidates) vs new inserts
  const { upsertCandidates, insertCandidates } = partitionBatch(batch, ctx.startIndex, result);

  if (upsertCandidates.length > 0) {
    await processUpserts(db, upsertCandidates, ctx, now, result);
  }
  if (insertCandidates.length > 0) {
    await processInserts(db, insertCandidates, ctx, now, result);
  }

  return result;
}

// ── Workflow ─────────────────────────────────────────────────────────────

export class ImportTasksWorkflow extends WorkflowEntrypoint<ImportTasksEnv, ImportTasksParams> {
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
      throw new TypeError('Invalid payload — expected array');
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
