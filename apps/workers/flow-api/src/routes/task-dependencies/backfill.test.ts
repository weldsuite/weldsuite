/**
 * The backfill of `task_dependencies` from `tasks.depends_on` (FLOW-015),
 * packages/core/db/drizzle/pending/task-dependencies-backfill.sql, run on pglite:
 * one fs / lag 0 row per entry, skipping deleted tasks, tasks of another
 * project and projects that do not exist, and safe to run twice.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const BACKFILL = readFileSync(
  path.resolve(__dirname, '../../../../../../packages/core/db/drizzle/pending/task-dependencies-backfill.sql'),
  'utf8',
);

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const run = () => db.execute(sql.raw(BACKFILL));

const rows = async (projectId: string) =>
  (await db.select().from(schema.taskDependencies).where(eq(schema.taskDependencies.projectId, projectId)))
    .map((row) => `${row.predecessorId}>${row.successorId}:${row.type}:${row.lagDays}:${row.createdBy}`)
    .sort();

describe('task-dependencies-backfill.sql', () => {
  it('makes one fs row per depends_on entry between live tasks of one project, and nothing else', async () => {
    const now = new Date('2026-11-01T08:00:00.000Z');
    await db.insert(schema.projects).values([
      { id: 'prj_bf_a', name: 'A', createdAt: now, updatedAt: now },
      { id: 'prj_bf_b', name: 'B', createdAt: now, updatedAt: now },
    ]);
    const task = (id: string, projectId: string | null, extra: Record<string, unknown> = {}) =>
      ({ id, title: id, projectId, ...extra }) as typeof schema.tasks.$inferInsert;
    await db.insert(schema.tasks).values([
      task('task_bf_1', 'prj_bf_a'),
      task('task_bf_2', 'prj_bf_a', { dependsOn: ['task_bf_1'], blocks: ['task_bf_3'] }),
      task('task_bf_3', 'prj_bf_a', { dependsOn: ['task_bf_1', 'task_bf_2', 'task_bf_3', 'task_bf_gone', 'task_bf_other', 'task_bf_personal', 'task_bf_missing'] }),
      task('task_bf_gone', 'prj_bf_a', { deletedAt: now }),
      task('task_bf_other', 'prj_bf_b'),
      task('task_bf_personal', null),
      // A deleted task keeps its arrays but gets no rows.
      task('task_bf_dead', 'prj_bf_a', { dependsOn: ['task_bf_1'], deletedAt: now }),
      // No array, an empty array.
      task('task_bf_4', 'prj_bf_a', { dependsOn: [] }),
      // A task whose project is not a project (no foreign key on tasks.project_id).
      task('task_bf_orphan_1', 'prj_bf_ghost'),
      task('task_bf_orphan_2', 'prj_bf_ghost', { dependsOn: ['task_bf_orphan_1'] }),
    ]);

    await run();

    expect(await rows('prj_bf_a')).toEqual([
      'task_bf_1>task_bf_2:fs:0:system',
      'task_bf_1>task_bf_3:fs:0:system',
      'task_bf_2>task_bf_3:fs:0:system',
    ]);
    expect(await rows('prj_bf_b')).toEqual([]);
    const [any] = await db.select().from(schema.taskDependencies).where(eq(schema.taskDependencies.successorId, 'task_bf_2'));
    expect(any.id).toMatch(/^tdp_[0-9a-f]{16}$/);
  });

  it('is safe to run again, and leaves the type and lag of a row that exists', async () => {
    await db
      .update(schema.taskDependencies)
      .set({ type: 'ss', lagDays: 3, createdBy: 'user_pm' })
      .where(eq(schema.taskDependencies.successorId, 'task_bf_2'));

    await run();

    expect(await rows('prj_bf_a')).toEqual([
      'task_bf_1>task_bf_2:ss:3:user_pm',
      'task_bf_1>task_bf_3:fs:0:system',
      'task_bf_2>task_bf_3:fs:0:system',
    ]);
  });
});
