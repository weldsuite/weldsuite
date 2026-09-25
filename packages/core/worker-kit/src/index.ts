/**
 * @weldsuite/worker-kit — what every WeldSuite API worker (app-api and the
 * per-module `<module>-api` workers) is built on: the Hono app factory, the
 * auth → tenant DB → feature-flag chain, CORS, response helpers and ids.
 *
 * Keep module code out of this package. Anything in here redeploys every API
 * worker when it changes (docs/plans/app-api-module-split.md).
 */

export { apiAuth, createModuleApi, ensurePermissionMiddleware, type ModuleApiOptions } from './app';
export { apiCors, resolveCorsOrigin } from './cors';
export type { Database, DbEnv, KitEnv, KitVariables } from './env';
export { FORWARDED_BY_HEADER, moduleForwarder, type ForwardEnv } from './forward';
export { generateId } from './id';
export { logSafe } from './log-safe';
export { clerkMiddleware } from './middleware/clerk';
export { featureFlagsMiddleware } from './middleware/feature-flags';
export { requestId } from './middleware/request-id';
export { workspaceDbMiddleware } from './middleware/workspace-db';
export { cursorPagination, error, list, noContent, success, type PaginationMeta } from './response';
