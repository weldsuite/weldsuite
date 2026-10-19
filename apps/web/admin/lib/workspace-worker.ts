import 'server-only';

import type { AdminIdentity } from './auth';
import {
  MAX_LIVE_PROJECT_IDS,
  isDatabaseMoveList,
  isDatabaseMoveView,
  isLiveDatabases,
  isShardSizes,
  type DatabaseMoveKind,
  type DatabaseMoveStatus,
  type DatabaseMoveView,
  type LiveDatabases,
  type ShardSizes,
  type WorkerState,
} from './database-moves';

/**
 * Server-only client for the workspace worker's admin API
 * (`/api/internal/admin/*`, task 1150), modelled on `mail-api.ts`. Database
 * moves run in the worker (a Workflow per move), and the live Neon state comes
 * from it, so the Move button, the move panel and the compute badges go
 * through here. This console holds the shared WORKSPACE_ADMIN_SECRET and passes
 * the signed-in admin and their role along; the worker refuses any change from
 * someone who is not a superadmin, and writes the audit rows itself.
 *
 * Everything else on the Databases screens reads the master DB, so they still
 * work, without moves and live data, when this is not configured.
 */

export type WorkerResult<T> = { ok: true; data: T } | { ok: false; code: string; error: string };

/** Page loads wait less than actions: the screens still render from the DB without the worker. */
const READ_TIMEOUT_MS = 8_000;
const WRITE_TIMEOUT_MS = 15_000;
/** A recovery talks to Neon and the tenant databases before it answers. */
const RECOVER_TIMEOUT_MS = 60_000;
/** Measuring sizes may have to wake the shard's compute first. */
const SIZES_TIMEOUT_MS = 30_000;

function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

function config(): { baseUrl: string; secret: string } | null {
  const baseUrl = withoutTrailingSlashes(process.env.WORKSPACE_WORKER_URL?.trim() ?? '');
  const secret = process.env.WORKSPACE_ADMIN_SECRET?.trim();
  if (!baseUrl || !secret) return null;
  return { baseUrl, secret };
}

export function isWorkspaceWorkerConfigured(): boolean {
  return config() !== null;
}

async function callWorkspaceWorker<T>(
  method: 'GET' | 'POST',
  path: string,
  options: { identity: AdminIdentity; body?: unknown; timeoutMs?: number },
): Promise<WorkerResult<T>> {
  const cfg = config();
  if (!cfg) {
    return {
      ok: false,
      code: 'NOT_CONFIGURED',
      error: 'The workspace worker is not configured for this console.',
    };
  }

  const headers: Record<string, string> = {
    'x-admin-secret': cfg.secret,
    'x-admin-email': options.identity.email,
    'x-admin-user-id': options.identity.userId,
    'x-admin-role': options.identity.role,
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/api/internal/admin${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(options.timeoutMs ?? (method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS)),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      code: timedOut ? 'TIMEOUT' : 'UNREACHABLE',
      error: timedOut ? 'The workspace worker did not answer in time.' : 'The workspace worker could not be reached.',
    };
  }

  const payload = (await res.json().catch(() => null)) as {
    data?: T;
    error?: { code?: string; message?: string };
  } | null;
  if (res.ok && payload && 'data' in payload) return { ok: true, data: payload.data as T };
  return {
    ok: false,
    code: payload?.error?.code ?? `HTTP_${res.status}`,
    error: payload?.error?.message ?? `The workspace worker answered ${res.status}.`,
  };
}

function toState<T>(result: WorkerResult<unknown>, check: (data: unknown) => data is T): WorkerState<T> {
  if (result.ok) {
    return check(result.data)
      ? { kind: 'ok', data: result.data }
      : {
          kind: 'error',
          message: 'The workspace worker sent an answer this console does not understand.',
        };
  }
  if (result.code === 'NOT_CONFIGURED') return { kind: 'not_configured' };
  return { kind: 'error', message: result.error };
}

function checked<T>(result: WorkerResult<unknown>, check: (data: unknown) => data is T): WorkerResult<T> {
  if (!result.ok) return result;
  return check(result.data)
    ? { ok: true, data: result.data }
    : {
        ok: false,
        code: 'BAD_RESPONSE',
        error: 'The workspace worker sent an answer this console does not understand.',
      };
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

/** Start moving a workspace's database to `target` (`dedicated`, `shard:auto` or a shard id). Superadmins only. */
export async function startDatabaseMove(
  identity: AdminIdentity,
  workspaceId: string,
  input: { target: string; reason: string },
): Promise<WorkerResult<{ moveId: string; kind: DatabaseMoveKind }>> {
  return callWorkspaceWorker('POST', `/workspaces/${encodeURIComponent(workspaceId)}/database-moves`, {
    identity,
    body: input,
  });
}

/** Ask a move to stop; it undoes itself at its next step. Superadmins only. */
export async function cancelDatabaseMove(
  identity: AdminIdentity,
  moveId: string,
): Promise<WorkerResult<{ moveId: string; status: DatabaseMoveStatus }>> {
  return callWorkspaceWorker('POST', `/database-moves/${encodeURIComponent(moveId)}/cancel`, { identity, body: {} });
}

export interface RecoveredMove {
  moveId: string;
  status: DatabaseMoveStatus;
  sourceUnlocked: boolean;
  targetReleased: boolean;
}

/** Finish undoing a stuck move; `force` for one whose Workflow is gone while it still looks live. Superadmins only. */
export async function recoverDatabaseMove(
  identity: AdminIdentity,
  moveId: string,
  force: boolean,
): Promise<WorkerResult<RecoveredMove>> {
  return callWorkspaceWorker('POST', `/database-moves/${encodeURIComponent(moveId)}/recover`, {
    identity,
    body: { force },
    timeoutMs: RECOVER_TIMEOUT_MS,
  });
}

/** One move with its per-table progress and verification, for the live panel. */
export async function loadDatabaseMove(
  identity: AdminIdentity,
  moveId: string,
): Promise<WorkerResult<DatabaseMoveView>> {
  const result = await callWorkspaceWorker<unknown>('GET', `/database-moves/${encodeURIComponent(moveId)}`, {
    identity,
  });
  return checked(result, isDatabaseMoveView);
}

/** The workspace's recent moves, newest first. */
export async function listWorkspaceDatabaseMoves(
  identity: AdminIdentity,
  workspaceId: string,
): Promise<WorkerState<DatabaseMoveView[]>> {
  const result = await callWorkspaceWorker<unknown>(
    'GET',
    `/workspaces/${encodeURIComponent(workspaceId)}/database-moves`,
    { identity },
  );
  return toState(result, isDatabaseMoveList);
}

// ---------------------------------------------------------------------------
// Live Neon state
// ---------------------------------------------------------------------------

/**
 * The compute state of every shard, plus the dedicated projects named (at most
 * {@link MAX_LIVE_PROJECT_IDS}). Asks the Neon API only, so it never wakes a
 * suspended compute.
 */
export async function loadLiveDatabases(
  identity: AdminIdentity,
  dedicatedProjectIds: readonly string[] = [],
): Promise<WorkerState<LiveDatabases>> {
  const ids = dedicatedProjectIds.slice(0, MAX_LIVE_PROJECT_IDS);
  const query = ids.length > 0 ? `?projectIds=${encodeURIComponent(ids.join(','))}` : '';
  const result = await callWorkspaceWorker<unknown>('GET', `/databases/live${query}`, { identity });
  return toState(result, isLiveDatabases);
}

/** The size of every database on a shard. Runs a query on the shard, so it WAKES its compute. Not for viewers. */
export async function measureShardSizes(identity: AdminIdentity, shardId: string): Promise<WorkerResult<ShardSizes>> {
  const result = await callWorkspaceWorker<unknown>('GET', `/databases/shards/${encodeURIComponent(shardId)}/sizes`, {
    identity,
    timeoutMs: SIZES_TIMEOUT_MS,
  });
  return checked(result, isShardSizes);
}
