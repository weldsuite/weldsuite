/**
 * OAuth and token connections: /api/merge/connections/:provider/*.
 *
 * Foundation stub (area B): an empty router, already mounted in src/index.ts.
 * Add the routes here; GET /:provider/authorize-url, POST /gitlab {host, token}, POST /azure_devops/organization (merge_connections:manage). Contract: schemas/weldmerge-providers.ts.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export default app;
