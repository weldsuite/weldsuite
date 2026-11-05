/**
 * Releases: /api/merge/releases.
 *
 * Foundation stub (area D): an empty router, already mounted in src/index.ts.
 * Add the routes here; GET/POST /, GET/PATCH/DELETE /:id, POST /:id/refresh|generate-notes|ship|publish (merge_releases:read | manage; events merge_release created/updated/deleted/shipped). Contract: schemas/weldmerge-across.ts.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export default app;
