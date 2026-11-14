/**
 * The live view's feed: sessions the collector saw, handed to the project's
 * PanelProject object (`touchLive`). A busy site would make that one call per
 * event, so touches are collected per isolate and sent at most every few
 * seconds per project:
 *
 * - a session keeps its page path changes in order (the object counts a new
 *   path as a page view) and only refreshes its time while the path stays;
 * - the first batch after a quiet spell is sent at once, later ones wait for
 *   the first batch past the interval (no timer: a stale live entry is gone
 *   after five minutes anyway, and the visitor's next batch comes seconds later).
 *
 * Nothing here is stored beyond the isolate's memory and the object's five
 * minute window.
 */

import type { PanelEventRow } from '@weldsuite/panel-domain/event-row';
import { projectObjectStub, type PanelLiveTouch } from '@weldsuite/panel-domain/project-object';
import type { Env } from '../env';
import { warnOnce } from './warn';

export const LIVE_FLUSH_INTERVAL_MS = 5 * 1000;
/** Per project and isolate: more sessions than this and the oldest are dropped from the pending set. */
const MAX_PENDING_SESSIONS = 1000;
/** Per session: page path changes kept between two sends. */
const MAX_PATH_CHANGES = 5;

/** Projects one isolate remembers a send time for; more than this and it starts over (a few extra sends). */
const MAX_REMEMBERED_PROJECTS = 2000;

const pending = new Map<string, Map<string, PanelLiveTouch[]>>();
const lastFlush = new Map<string, number>();

function toTouch(row: PanelEventRow): PanelLiveTouch | null {
  // Page-bound web events only: not the leave beacon, not server events.
  if (row.lib === 'server' || row.name === '$pageleave' || row.path === '') return null;
  return {
    sessionId: row.session_id ?? row.anon_id,
    distinctId: row.distinct_id,
    path: row.path,
    title: row.title,
    country: row.country,
    deviceType: row.device_type,
    ts: row.ts,
  };
}

function add(projectId: string, touch: PanelLiveTouch): void {
  let sessions = pending.get(projectId);
  if (!sessions) {
    sessions = new Map();
    pending.set(projectId, sessions);
  }
  const path = sessions.get(touch.sessionId) ?? [];
  const last = path[path.length - 1];
  if (last && last.path === touch.path) {
    // Same page: the later touch replaces the earlier (newer time, title).
    path[path.length - 1] = touch;
  } else {
    path.push(touch);
    if (path.length > MAX_PATH_CHANGES) path.shift();
  }
  // Re-insert so the most recently seen session is last: the oldest go first when the set is full.
  sessions.delete(touch.sessionId);
  sessions.set(touch.sessionId, path);
  if (sessions.size > MAX_PENDING_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
  }
}

/** Notes the batch's sessions and sends what is pending when the interval has passed. */
export async function trackLive(env: Env, projectId: string, rows: PanelEventRow[], now: number): Promise<void> {
  if (!env.PANEL_PROJECT) {
    warnOnce('binding:PANEL_PROJECT', 'PANEL_PROJECT is not bound: the live view, identities and people are off');
    return;
  }
  for (const row of rows) {
    const touch = toTouch(row);
    if (touch) add(projectId, touch);
  }

  const sessions = pending.get(projectId);
  if (!sessions || sessions.size === 0) return;
  const last = lastFlush.get(projectId);
  if (last !== undefined && now - last < LIVE_FLUSH_INTERVAL_MS) return;

  pending.delete(projectId);
  if (lastFlush.size >= MAX_REMEMBERED_PROJECTS) lastFlush.clear();
  lastFlush.set(projectId, now);
  const touches = [...sessions.values()].flat();
  try {
    await projectObjectStub(env.PANEL_PROJECT, projectId).touchLive(touches);
  } catch (error) {
    console.error(`[panel-ingest] Live view update failed for project ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Forgets what is pending. Tests only: an isolate keeps it. */
export function resetLive(): void {
  pending.clear();
  lastFlush.clear();
}
