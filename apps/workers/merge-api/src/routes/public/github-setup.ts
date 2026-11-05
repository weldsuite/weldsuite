/**
 * The GitHub App's setup redirect: /public/merge/github/setup (no Clerk session).
 *
 * Foundation stub (area A): an empty router, already mounted in src/index.ts.
 * Add the routes here; GET /setup?installation_id&setup_action&state verifies the signed state, records the installation (@weldsuite/merge-domain/installations) and redirects to returnTo. Contract: schemas/weldmerge-sync.ts.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export default app;
