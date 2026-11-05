/**
 * Member account linking: /api/merge/accounts/:provider/*.
 *
 * Foundation stub (area B): an empty router, already mounted in src/index.ts.
 * Add the routes here; GET /:provider/authorize-url, POST /gitlab-token, DELETE /:provider?host= (merge_pull_requests:read, own account only, no entity event). Contract: schemas/weldmerge-providers.ts.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export default app;
