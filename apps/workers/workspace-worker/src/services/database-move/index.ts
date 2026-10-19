/**
 * Database moves (TASK-1150): what the admin routes and the recovery tooling
 * call. The Workflow itself is `workflows/move-database.ts`.
 *
 *  - `startDatabaseMove` / `requestMoveCancel`: validate and create a move, ask a live one to stop;
 *  - `recoverDatabaseMove` / `compensateDatabaseMove` / `unlockMoveSource`: undo a move that is stuck
 *    (failed or cancelling with the source still locked or a target still allocated);
 *  - `createMoveDeps`: the production dependencies, built from the Worker env.
 */

export * from './compensate';
export { createMoveDeps, retentionDaysFromEnv, DEFAULT_DATABASE_MOVE_RETENTION_DAYS, type MoveDeps } from './deps';
export * from './errors';
export { describeFailure } from './failure';
export * from './start';
export { hasActiveMove } from './state';
