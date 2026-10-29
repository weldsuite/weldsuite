/**
 * The writes behind `POST /e`, run in `waitUntil` after the 204: events to the
 * Basin stream, the day's count to PanelUsage, the install-check timestamp to KV.
 */

import type { PanelProjectRecord } from '@weldsuite/panel-domain/registry';
import type { EventBatch } from '@weldsuite/panel-domain/wire';
import type { Env } from '../env';
import { buildEventRows, consentedAnonId } from './rows';
import { touchSeen } from './seen';
import { utcDate } from './time';
import { parseUserAgent } from './user-agent';
import { cookielessVisitorId, todaysSalt } from './visitor';

export interface AcceptedBatch {
  project: PanelProjectRecord;
  batch: EventBatch;
  receivedAt: number;
  /** Used for the cookieless hash only, never stored. */
  ip: string;
  userAgent: string;
  geo: { country: string | null; region: string | null; city: string | null };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Failures are logged with ids and counts only, never request data. */
function logFailure(what: string, project: PanelProjectRecord, error: unknown): void {
  console.error(`[panel-ingest] ${what} failed for project ${project.projectId}: ${messageOf(error)}`);
}

export async function collectEvents(env: Env, accepted: AcceptedBatch): Promise<void> {
  const { project, batch, receivedAt, ip, userAgent, geo } = accepted;

  // Events that need a cookieless id are left out when the salt is unavailable:
  // an id built without it would be stable across days.
  let cookielessId: string | null = null;
  if (batch.events.some((event) => consentedAnonId(batch, event) === null)) {
    try {
      const salt = await todaysSalt(env.PANEL_SALT, receivedAt);
      cookielessId = await cookielessVisitorId(salt, project.projectId, ip, userAgent);
    } catch (error) {
      logFailure('Salt lookup', project, error);
    }
  }

  const rows = buildEventRows({
    record: project,
    batch,
    receivedAt,
    userAgent: parseUserAgent(userAgent),
    geo,
    cookielessId,
  });
  if (rows.length === 0) return;

  await env.PANEL_EVENTS.send(rows);

  // Counting and the install check never fail the write that already happened.
  const bookkeeping = await Promise.allSettled([
    env.PANEL_USAGE.get(env.PANEL_USAGE.idFromName(project.workspaceId)).add(utcDate(receivedAt), rows.length),
    touchSeen(env.WORKSPACE_CACHE, project.projectId, receivedAt),
  ]);
  for (const result of bookkeeping) {
    if (result.status === 'rejected') logFailure('Usage count or seen marker', project, result.reason);
  }
}

/** For the route's `waitUntil`: a failed write is logged, not thrown into the runtime. */
export function collectInBackground(env: Env, accepted: AcceptedBatch): Promise<void> {
  return collectEvents(env, accepted).catch((error) => logFailure('Event write', accepted.project, error));
}
