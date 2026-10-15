/**
 * WeldReach (cold email outreach) on the public API: /v1/reach/*
 *
 * docs/plans/weldreach-external-api.md. One router, a file per object, mounted
 * at `/reach` in `routes/v1/index.ts`. Scopes are the permission objects:
 * reach_campaigns, reach_prospects, reach_settings (suppressions), reach_inbox
 * (`read`, and `reply` by name) and reach_mailboxes (read only).
 *
 * Every request first passes `reachAccess`: staff must have approved the
 * workspace for WeldReach, else 403 APP_ACCESS_REQUIRED. The routes run the
 * domain functions reach-api runs (`@weldsuite/reach-domain`), so a
 * `ReachDomainError` is answered with its own code and status; the route files
 * reach this worker only through `lib/reach.ts`.
 */

import { Hono } from 'hono';
import type { HonoEnv } from '../../../types';
import { reachAccess, reachErrorHandler } from '../../../lib/reach';
import access from './access';
import campaigns from './campaigns';
import domains from './domains';
import lists from './lists';
import mailboxes from './mailboxes';
import overview from './overview';
import prospects from './prospects';
import suppressions from './suppressions';
import threads from './threads';

const app = new Hono<HonoEnv>();

app.onError(reachErrorHandler);
app.use('*', reachAccess);

app.route('/access', access);
app.route('/campaigns', campaigns);
app.route('/domains', domains);
app.route('/lists', lists);
app.route('/mailboxes', mailboxes);
app.route('/overview', overview);
app.route('/prospects', prospects);
app.route('/suppressions', suppressions);
app.route('/threads', threads);
// external-api also mounts `thread-reply.ts` here. It is deliberately absent: the MCP server reads the inbox and never sends.

export default app;
