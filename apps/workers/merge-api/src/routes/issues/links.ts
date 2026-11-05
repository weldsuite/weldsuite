/**
 * Record links of an issue: /api/merge/issues/:id/links.
 *
 * Foundation stub (area D): an empty router, already mounted in src/index.ts.
 * Add the routes here; GET/POST /:id/links, DELETE /:id/links/:linkId (merge_issues:read to read, merge_issues:update to change; events merge_record_link created/deleted). Contract: schemas/weldmerge-across.ts.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export default app;
