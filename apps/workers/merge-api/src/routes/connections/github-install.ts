/**
 * GitHub App install flow: /api/merge/connections/github/install-url.
 *
 * Foundation stub (area A): an empty router, already mounted in src/index.ts.
 * Add the routes here; GET /github/install-url?returnTo= (merge_connections:manage) answers { url }; the state is an HS256 JWT signed with CLERK_SECRET_KEY. Contract: schemas/weldmerge-sync.ts.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export default app;
