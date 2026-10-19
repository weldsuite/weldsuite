/**
 * "This workspace is moving": what every first-party API answers while a
 * workspace's tenant database is being moved between a shared Neon shard and a
 * dedicated project (TASK-1150, ADR DATA-016).
 *
 * The answer is `503 WORKSPACE_MOVING` with `Retry-After`, so clients retry
 * instead of failing. It comes from two places:
 *
 *  - `licenceGate()`, from the master DB: the workspace has a move row in a
 *    write-blocking status, so a write is refused up front (with the same
 *    exceptions as the licence read-only mode: reads, search, the user-level
 *    paths).
 *  - `createModuleApi`'s `onError`, from the tenant DB: the move's lock has
 *    reached the database. The source is read-only (writes fail with 25006) and
 *    its role password was rotated (a request still holding the old URL fails
 *    with 28P01). Both mean "the workspace moved under this request".
 *
 * external-api and mcp-server have their own tenant resolution and answer the
 * same way: they import this file (`@weldsuite/worker-kit/workspace-moving`)
 * rather than copy the rule, so the code, body and `Retry-After` stay one thing.
 */

import type { Context } from 'hono';
import { inArray, sql } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { isPasswordAuthFailure, isReadOnlyTransaction } from './pg-errors';

/** How long clients are told to wait: a move drains in 60 to 90 seconds at the soonest. */
export const WORKSPACE_MOVING_RETRY_AFTER_SECONDS = 30;

/** The 503 body every API answers during a move, so all workers answer alike. */
export function workspaceMovingBody() {
  return {
    error: {
      code: 'WORKSPACE_MOVING',
      message: 'This workspace is being moved to a new database. Try again in a minute.',
    },
  } as const;
}

/** 503 WORKSPACE_MOVING + `Retry-After`. */
export function workspaceMovingResponse(c: Context): Response {
  return c.json(workspaceMovingBody(), 503, {
    'Retry-After': String(WORKSPACE_MOVING_RETRY_AFTER_SECONDS),
  });
}

/**
 * Does this workspace have a database move in a write-blocking status
 * (`WRITE_BLOCKING_DATABASE_MOVE_STATUSES`)? For the master query that resolves
 * a workspace: a select field of a query over `workspaces`.
 * `workspace_database_moves.workspace_id` is the `ws_…` id, not the Clerk org
 * id. A correlated EXISTS, so it rides the one workspace query.
 *
 * The decoder reads only a real boolean (or Postgres's `t`): a driver that
 * handed back the string `f` must not turn every workspace into "moving".
 */
export function databaseMoveInProgressSql() {
  const moves = masterSchema.workspaceDatabaseMoves;
  return sql<boolean>`exists (
    select 1 from ${moves}
    where ${moves.workspaceId} = ${masterSchema.workspaces.id}
      and ${inArray(moves.status, [...masterSchema.WRITE_BLOCKING_DATABASE_MOVE_STATUSES])}
  )`.mapWith((value: unknown) => value === true || value === 't');
}

/**
 * How a tenant database refused a request because the workspace moved:
 *  - `read_only`: the source was set read-only (25006).
 *  - `password_rotated`: the source role's password was rotated (28P01), so the
 *    URL this request holds is dead and any cached copy of it must go.
 */
export type MovedDatabaseFailure = 'read_only' | 'password_rotated';

/** Is `err` the database saying the workspace moved? null for any other error. */
export function classifyMovedDatabaseError(err: unknown): MovedDatabaseFailure | null {
  if (isPasswordAuthFailure(err)) return 'password_rotated';
  if (isReadOnlyTransaction(err)) return 'read_only';
  return null;
}
