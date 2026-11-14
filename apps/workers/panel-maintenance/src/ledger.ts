/**
 * MaintenanceLedger: the erasures waiting for the next Iceberg rewrite.
 *
 * Erasing a person is two steps (ADR PANEL-002): panel-api has the PanelProject
 * object drop the profile and exclude the ids from every query at once, then
 * queues the ids here. The rewrite itself is a table-wide job, so the queue
 * consumer only records the ids, and the weekly run takes everything recorded
 * so far in one pass. An id leaves the ledger when the rewrite that covered it
 * succeeded and the project object was told to stop excluding it.
 *
 * One instance (`idFromName('global')`), SQLite storage.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import type { EraseMessage } from './messages';

export interface PendingErasure {
  workspaceId: string;
  projectId: string;
  ids: string[];
  /** When the oldest of these ids was queued, ISO 8601. */
  oldest: string;
}

export interface RunRecord {
  runId: string;
  finishedAt: string;
  erasedIds: number;
  summary: string;
}

export class MaintenanceLedger extends DurableObject<Env> {
  private ready = false;

  private sql() {
    const sql = this.ctx.storage.sql;
    if (!this.ready) {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS erasures (
           project_id TEXT NOT NULL,
           workspace_id TEXT NOT NULL,
           erased_id TEXT NOT NULL,
           queued_at TEXT NOT NULL,
           PRIMARY KEY (project_id, erased_id)
         )`,
      );
      sql.exec(`CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, finished_at TEXT NOT NULL, erased_ids INTEGER NOT NULL, summary TEXT NOT NULL)`);
      this.ready = true;
    }
    return sql;
  }

  /**
   * Records the ids. An id already waiting gets the new queue time: a rewrite that started
   * before it was queued again has not covered what came after, so it must stay.
   * Returns how many distinct ids it recorded.
   */
  async addErasure(message: Pick<EraseMessage, 'workspaceId' | 'projectId' | 'ids'>, now: Date = new Date()): Promise<number> {
    const sql = this.sql();
    const queuedAt = now.toISOString();
    const ids = [...new Set(message.ids)];
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) {
        sql.exec(
          'INSERT INTO erasures (project_id, workspace_id, erased_id, queued_at) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, erased_id) DO UPDATE SET queued_at = excluded.queued_at',
          message.projectId,
          message.workspaceId,
          id,
          queuedAt,
        );
      }
    });
    return ids.length;
  }

  /** Everything waiting, grouped by project. */
  async pending(): Promise<PendingErasure[]> {
    const rows = this.sql()
      .exec('SELECT project_id, workspace_id, erased_id, queued_at FROM erasures ORDER BY project_id, queued_at, erased_id')
      .toArray() as Array<{ project_id: string; workspace_id: string; erased_id: string; queued_at: string }>;
    const byProject = new Map<string, PendingErasure>();
    for (const row of rows) {
      const group = byProject.get(row.project_id) ?? { workspaceId: row.workspace_id, projectId: row.project_id, ids: [], oldest: row.queued_at };
      group.ids.push(row.erased_id);
      if (row.queued_at < group.oldest) group.oldest = row.queued_at;
      byProject.set(row.project_id, group);
    }
    return [...byProject.values()];
  }

  /** Of `ids`, those still waiting that were last queued at or before `before`: the ones a rewrite that began then covered. */
  async settled(projectId: string, ids: string[], before: string): Promise<string[]> {
    const sql = this.sql();
    const out: string[] = [];
    for (const id of new Set(ids)) {
      const row = sql.exec('SELECT queued_at FROM erasures WHERE project_id = ? AND erased_id = ?', projectId, id).toArray()[0] as { queued_at: string } | undefined;
      if (row && row.queued_at <= before) out.push(id);
    }
    return out;
  }

  /** Removes ids whose rewrite succeeded and whose project object was told to stop excluding them. */
  async complete(projectId: string, ids: string[]): Promise<void> {
    const sql = this.sql();
    this.ctx.storage.transactionSync(() => {
      for (const id of new Set(ids)) sql.exec('DELETE FROM erasures WHERE project_id = ? AND erased_id = ?', projectId, id);
    });
  }

  async recordRun(run: RunRecord): Promise<void> {
    this.sql().exec('INSERT OR REPLACE INTO runs (run_id, finished_at, erased_ids, summary) VALUES (?, ?, ?, ?)', run.runId, run.finishedAt, run.erasedIds, run.summary);
  }

  /** The last runs, newest first. */
  async runs(limit = 10): Promise<RunRecord[]> {
    const rows = this.sql()
      .exec('SELECT run_id, finished_at, erased_ids, summary FROM runs ORDER BY finished_at DESC LIMIT ?', limit)
      .toArray() as Array<{ run_id: string; finished_at: string; erased_ids: number; summary: string }>;
    return rows.map((row) => ({ runId: row.run_id, finishedAt: row.finished_at, erasedIds: row.erased_ids, summary: row.summary }));
  }
}
