/**
 * WeldChat subscriptions: /api/merge/chat-subscriptions.
 *
 * Foundation stub (area D): an empty router, already mounted in src/index.ts.
 * Add the routes here; GET/POST /, PATCH/DELETE /:id (merge_teams:manage; events merge_chat_subscription created/updated/deleted). Contract: schemas/weldmerge-across.ts.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export default app;
