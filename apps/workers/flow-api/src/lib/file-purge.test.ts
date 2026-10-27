/**
 * The file-purge due index: a delete marks its workspace due at the end of the
 * retention window (ADR DATA-008: the purge sweep reads D1, it does not look at
 * every tenant).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { RETENTION_DAYS, markFilePurgeDue, purgeDueAt } from './file-purge';

const MIGRATION = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql',
  ),
  'utf8',
);

const DAY = 24 * 60 * 60 * 1000;
const DELETED_AT = new Date('2031-07-10T10:00:00.000Z');

function fakeContext(d1: D1Database | undefined, clerkOrgId = 'org_files') {
  const pending: Promise<unknown>[] = [];
  const c = {
    env: { SCHEDULE_INDEX: d1 },
    get: (key: string) => (key === 'clerkOrgId' ? clerkOrgId : undefined),
    executionCtx: { waitUntil: (p: Promise<unknown>) => pending.push(p) },
  };
  return { c: c as unknown as Parameters<typeof markFilePurgeDue>[0], settled: () => Promise.all(pending) };
}

const dueAt = (d1: D1Database, workspaceId: string, kind = 'file_purge') =>
  d1
    .prepare('SELECT next_due_at FROM workspace_due_index WHERE kind = ? AND workspace_id = ?')
    .bind(kind, workspaceId)
    .first<number>('next_due_at');

describe('purgeDueAt', () => {
  it('is the end of the retention window', () => {
    expect(purgeDueAt(DELETED_AT).getTime()).toBe(DELETED_AT.getTime() + RETENTION_DAYS * DAY);
  });
});

describe('markFilePurgeDue', () => {
  it('marks the workspace due when the deleted file leaves retention', async () => {
    const d1 = createSqliteD1(MIGRATION);
    const { c, settled } = fakeContext(d1);
    markFilePurgeDue(c, DELETED_AT);
    await settled();
    expect(await dueAt(d1, 'org_files')).toBe(purgeDueAt(DELETED_AT).getTime());
  });

  it('only ever pulls the due time earlier', async () => {
    const d1 = createSqliteD1(MIGRATION);
    const first = fakeContext(d1);
    markFilePurgeDue(first.c, DELETED_AT);
    await first.settled();
    const later = fakeContext(d1);
    markFilePurgeDue(later.c, new Date(DELETED_AT.getTime() + 5 * DAY));
    await later.settled();
    expect(await dueAt(d1, 'org_files')).toBe(purgeDueAt(DELETED_AT).getTime());
  });

  it('is a no-op without the schedule-index binding', () => {
    const { c } = fakeContext(undefined);
    expect(() => markFilePurgeDue(c, DELETED_AT)).not.toThrow();
  });
});
