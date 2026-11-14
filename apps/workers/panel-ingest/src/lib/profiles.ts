/**
 * What a batch tells the project's PanelProject object about people: the
 * `$identify` links and the profile operations. Both are personal data and
 * run only for a consenting visitor (the server API has no browser, so no
 * consent to wait for). The object is reached through `projectObjectStub`
 * only (EU jurisdiction); without the binding this warns once and does nothing.
 */

import { correctTimestamp } from './rows';
import { projectObjectStub, type PanelPeopleOp } from '@weldsuite/panel-domain/project-object';
import type { PanelProjectRecord } from '@weldsuite/panel-domain/registry';
import type { EventBatch, WirePeopleOp } from '@weldsuite/panel-domain/wire';
import type { Env } from '../env';
import { warnOnce } from './warn';

export function toPeopleOps(ops: readonly WirePeopleOp[]): PanelPeopleOp[] {
  return ops.map((op): PanelPeopleOp => {
    switch (op.op) {
      case 'unset':
        return { op: 'unset', userId: op.user_id, ts: op.ts, keys: op.keys };
      case 'increment':
        return { op: 'increment', userId: op.user_id, ts: op.ts, props: op.props };
      case 'set':
      case 'set_once':
        return { op: op.op, userId: op.user_id, ts: op.ts, props: op.props };
    }
  });
}

function logFailure(what: string, project: Pick<PanelProjectRecord, 'projectId'>, error: unknown): void {
  console.error(`[panel-ingest] ${what} failed for project ${project.projectId}: ${error instanceof Error ? error.message : String(error)}`);
}

function projectObject(env: Env) {
  if (!env.PANEL_PROJECT) {
    warnOnce('binding:PANEL_PROJECT', 'PANEL_PROJECT is not bound: the live view, identities and people are off');
    return null;
  }
  return env.PANEL_PROJECT;
}

/** `$identify` events and `people` operations of a consented browser batch. */
export async function applyBatchPeople(env: Env, project: PanelProjectRecord, batch: EventBatch, receivedAt: number): Promise<void> {
  if (!batch.consent) return;
  const identifies = batch.events.filter((event) => event.name === '$identify' && event.anon_id && event.user_id);
  const ops = batch.people ?? [];
  if (identifies.length === 0 && ops.length === 0) return;

  const namespace = projectObject(env);
  if (!namespace) return;
  const stub = projectObjectStub(namespace, project.projectId);

  for (const event of identifies) {
    try {
      await stub.identify({
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        anonId: event.anon_id!,
        userId: event.user_id!,
        ts: new Date(correctTimestamp(event.ts, batch.sent_at, receivedAt)).toISOString(),
      });
    } catch (error) {
      logFailure('Identify', project, error);
    }
  }
  if (ops.length > 0) {
    try {
      await stub.applyPeopleOps({ workspaceId: project.workspaceId, projectId: project.projectId, ops: toPeopleOps(ops) });
    } catch (error) {
      logFailure('People update', project, error);
    }
  }
}

/** Profile operations of a server batch. */
export async function applyServerPeople(env: Env, project: Pick<PanelProjectRecord, 'workspaceId' | 'projectId'>, ops: readonly WirePeopleOp[]): Promise<void> {
  if (ops.length === 0) return;
  const namespace = projectObject(env);
  if (!namespace) return;
  try {
    await projectObjectStub(namespace, project.projectId).applyPeopleOps({
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      ops: toPeopleOps(ops),
    });
  } catch (error) {
    logFailure('People update', project, error);
  }
}
