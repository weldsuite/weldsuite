/**
 * Record link lookup: /api/merge/record-links.
 *
 * Foundation stub (area D): an empty router, already mounted in src/index.ts.
 * Add the routes here; GET /?recordType=&recordId= (merge_issues:read): the issues a ticket, company or chat channel shows. Contract: schemas/weldmerge-across.ts.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export default app;
