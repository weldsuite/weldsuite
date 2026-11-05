/**
 * OAuth callback: /api/merge/oauth/callback.
 *
 * Foundation stub (area B): an empty router, already mounted in src/index.ts.
 * Add the routes here; POST /callback {code, state} (Clerk-authenticated; the state's user and workspace must match the caller). Contract: schemas/weldmerge-providers.ts.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export default app;
