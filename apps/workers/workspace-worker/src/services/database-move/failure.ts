/**
 * Turning an error into text that is safe to store on a move row and to log.
 *
 * What may leak, and how it is kept out:
 *  - connection strings and passwords: any `postgres(ql)://` run is redacted;
 *  - row contents: a Postgres error message can quote a value (`invalid input
 *    syntax for type integer: "abc"`) and Drizzle's wrapper carries the SQL and
 *    its parameters. A database error is therefore reported by SQLSTATE only.
 * Errors this code throws itself (`MoveFlowError`, the engine's
 * `DatabaseMoveError`) are written to be safe and pass through.
 */

import { NeonApiError } from '@weldsuite/neon-provisioning';
import { DatabaseMoveError, GuardError } from '../../lib/database-move/errors';
import { isDrizzleQueryError, isPasswordAuthFailure, isReadOnlyTransaction, sqlStateOf } from '../../lib/database-move/pg-errors';
import { MoveCancelledError, MoveFlowError } from './errors';

const MAX_MESSAGE_CHARS = 300;

function redactUrls(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, 'postgres://[redacted]');
}

/** Safe, single-line text for a stored error or a log line. */
export function describeFailure(err: unknown): string {
  if (err instanceof MoveFlowError || err instanceof MoveCancelledError) return err.message;
  if (err instanceof DatabaseMoveError) return redactUrls(`${err.code}: ${err.message}`).slice(0, MAX_MESSAGE_CHARS);
  if (err instanceof NeonApiError) return `Neon API error (HTTP ${err.status})`;
  if (isPasswordAuthFailure(err)) return 'Database error 28P01 (password authentication failed)';
  if (isReadOnlyTransaction(err)) return 'Database error 25006 (read-only transaction)';
  const state = sqlStateOf(err);
  if (state) return `Database error ${state}`;
  if (isDrizzleQueryError(err)) return 'Database query failed';
  if (err instanceof Error) return redactUrls(`${err.name}: ${err.message}`).replace(/\s+/g, ' ').slice(0, MAX_MESSAGE_CHARS);
  return 'Unknown error';
}

/** True for a failure no retry can fix: the step must fail at once instead of burning its retries. */
export function isPermanentFailure(err: unknown): boolean {
  if (err instanceof MoveCancelledError) return true;
  if (err instanceof MoveFlowError) return !err.retryable;
  // Engine errors describe the data (journal, schema, keys, cursors): retrying cannot change them. A guard
  // that did not take effect (sessions survived the terminate) is the exception: the next attempt may.
  if (err instanceof DatabaseMoveError) return !(err instanceof GuardError);
  return false;
}

/**
 * The text of an error that already went through {@link describeFailure} (an
 * error that crossed a step boundary carries that text as its message) or that
 * this code threw itself. Used where the original error object is gone.
 */
export function storedMessageOf(err: unknown): string {
  if (err instanceof Error) return redactUrls(err.message).replace(/\s+/g, ' ').slice(0, MAX_MESSAGE_CHARS);
  return describeFailure(err);
}
