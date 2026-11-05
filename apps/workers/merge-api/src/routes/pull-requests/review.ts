/**
 * Review and merge: /api/merge/pull-requests/:id/{files,threads,reviews,comments,merge}.
 *
 * Foundation stub (area C): an empty router, already mounted in src/index.ts.
 * Add the routes here; merge_pull_requests:read for files and threads, :review for reviews and comments, :merge for merge; member token via getMemberToken. Contract: schemas/weldmerge-review.ts.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export default app;
