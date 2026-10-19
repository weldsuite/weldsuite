/**
 * Typed errors of the database-move service and Workflow.
 *
 * Messages here are written by this code and are safe to store on the move row
 * and show in the admin console: they never carry a connection string, a
 * password or row contents. Errors from drivers and APIs go through
 * `describeFailure` (failure.ts) before they reach a row or a log line.
 */

/** Why a request to start, cancel or recover a move was refused. */
export type DatabaseMoveRequestErrorCode =
  | 'INVALID_INPUT'
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_NOT_PROVISIONED'
  | 'WORKSPACE_DELETED'
  | 'WORKSPACE_SCHEDULED_FOR_DELETION'
  | 'MOVE_ALREADY_ACTIVE'
  | 'ALREADY_PLACED'
  | 'SHARD_NOT_FOUND'
  | 'SHARD_UNAVAILABLE'
  | 'WORKFLOW_START_FAILED'
  | 'MOVE_NOT_FOUND'
  | 'MOVE_NOT_CANCELLABLE'
  | 'MOVE_NOT_RECOVERABLE';

const HTTP_STATUS: Record<DatabaseMoveRequestErrorCode, 400 | 404 | 409 | 422 | 502> = {
  INVALID_INPUT: 400,
  WORKSPACE_NOT_FOUND: 404,
  WORKSPACE_NOT_PROVISIONED: 422,
  WORKSPACE_DELETED: 422,
  WORKSPACE_SCHEDULED_FOR_DELETION: 422,
  MOVE_ALREADY_ACTIVE: 409,
  ALREADY_PLACED: 422,
  SHARD_NOT_FOUND: 404,
  SHARD_UNAVAILABLE: 422,
  WORKFLOW_START_FAILED: 502,
  MOVE_NOT_FOUND: 404,
  MOVE_NOT_CANCELLABLE: 409,
  MOVE_NOT_RECOVERABLE: 409,
};

/** A request to start, cancel or recover a move that the service refuses. `httpStatus` is a suggestion for the route. */
export class DatabaseMoveRequestError extends Error {
  readonly httpStatus: 400 | 404 | 409 | 422 | 502;

  constructor(
    readonly code: DatabaseMoveRequestErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DatabaseMoveRequestError';
    this.httpStatus = HTTP_STATUS[code];
  }
}

export type MoveFlowErrorCode =
  | 'MOVE_NOT_FOUND'
  | 'MOVE_ENDED'
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_CHANGED'
  | 'WORKSPACE_NOT_MOVABLE'
  | 'SOURCE_NOT_CURRENT'
  | 'TARGET_LOST'
  | 'NOT_CONFIGURED'
  | 'VERIFICATION_FAILED'
  | 'COMPENSATION_INCOMPLETE';

/** Message of the error a step throws when the move was cancelled; the catch in `run` recognises it by the row, not the name. */
export const MOVE_CANCELLED_MESSAGE = 'MOVE_CANCELLED';

/** The move was cancelled: the row says so. Never retried. */
export class MoveCancelledError extends Error {
  constructor() {
    super(MOVE_CANCELLED_MESSAGE);
    this.name = 'MoveCancelledError';
  }
}

/**
 * A failure of the move itself. `retryable` tells the step wrapper whether
 * Cloudflare should try the step again: false for anything a retry cannot fix
 * (the source is behind the bundled migrations, the workspace changed under the
 * move, the verification found a difference).
 */
export class MoveFlowError extends Error {
  constructor(
    readonly code: MoveFlowErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'MoveFlowError';
  }
}
