/**
 * Per-member inbox state: /api/merge/inbox/items/:itemKey and /api/merge/inbox/read-all.
 *
 * Foundation stub (area A): an empty router, already mounted in src/index.ts.
 * Add the routes here; PATCH /items/:itemKey, POST /read-all (merge_pull_requests:read, own rows only, no entity event: listed as exempt in routes/_sweeps.test.ts). Contract: schemas/weldmerge-sync.ts.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export default app;
