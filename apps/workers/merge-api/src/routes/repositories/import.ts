/**
 * Issue import: /api/merge/repositories/:id/import-issues.
 *
 * Foundation stub (area A): an empty router, already mounted in src/index.ts.
 * Add the routes here; POST /:id/import-issues (merge_connections:manage), up to 500 open provider issues. Contract: schemas/weldmerge-sync.ts.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export default app;
