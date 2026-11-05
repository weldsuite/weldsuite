/**
 * Issue to provider issue links: /api/merge/issues/:id/external.
 *
 * Foundation stub (area A): an empty router, already mounted in src/index.ts.
 * Add the routes here; POST /:id/external {repositoryId} (merge_issues:update), DELETE /:id/external. Contract: schemas/weldmerge-sync.ts.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export default app;
