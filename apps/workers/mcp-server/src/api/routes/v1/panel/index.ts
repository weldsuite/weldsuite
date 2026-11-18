/**
 * `/v1/panel` (the MCP server's copy of external-api's route, which the
 * `weldpanel_*` tools in src/tools/panel call) — WeldPanel product analytics, read-only, through panel-api's
 * PanelApiInternal entrypoint (PANEL_INTERNAL, `/internal/panel/v1/*`).
 * Scope `panel:read`.
 *
 *   GET  /v1/panel/projects                     → tracked projects
 *   POST /v1/panel/query                        → run a typed query spec (no SQL); the body is the spec, or { spec }
 *   GET  /v1/panel/reports[?projectId&kind]     → saved reports
 *   GET  /v1/panel/reports/:id                  → one report
 *   GET  /v1/panel/reports/:id/results[?preset] → the report run (today|7d|30d|90d|12m)
 *   GET  /v1/panel/dashboards[?projectId]       → dashboards
 *   GET  /v1/panel/dashboards/:id               → one dashboard with its tiles
 *   GET  /v1/panel/cohorts?projectId            → saved cohorts
 *   GET  /v1/panel/events?projectId             → the lexicon: event and property names seen
 *   GET  /v1/panel/people?projectId[&search]    → tracked people
 *   GET  /v1/panel/people/:distinctId?projectId → one person's profile
 *   GET  /v1/panel/groups?projectId&type        → group profiles (companies, accounts)
 *   GET  /v1/panel/groups/:type/:key?projectId  → one group: profile, members, recent events
 *
 * Who the call acts for: a personal key acts as its owner (their private
 * reports and their WeldPanel permissions); a workspace key reads shared
 * reports and dashboards only. panel-api answers with its own DTOs, passed
 * through as they are. Without the binding (the Rust backend's editions)
 * every route answers 503.
 */

import { Hono, type Context } from 'hono';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';

/** Largest query spec accepted (a spec is small; this stops a body being used as a payload). */
const MAX_SPEC_BYTES = 64 * 1024;

const SCOPE = 'panel:read';

const app = new Hono<HonoEnv>();

function unavailable(c: Context<HonoEnv>) {
  return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'WeldPanel is not available on this server' } }, 503);
}

/** Who the call acts for, as panel-api's internal routes read it. */
function actorHeaders(c: Context<HonoEnv>): Record<string, string> | null {
  const session = c.get('apiSession');
  if (!session) return null;
  return session.userId ? { 'x-weld-user': session.userId } : { 'x-weld-workspace-key': session.keyId };
}

/** Forwards to `/internal/panel/v1/<workspace><path>` with the query string, and passes the answer through. */
async function forward(c: Context<HonoEnv>, path: string, body?: string): Promise<Response> {
  const fetcher = c.env.PANEL_INTERNAL;
  const session = c.get('apiSession');
  const actor = actorHeaders(c);
  if (!fetcher || !session || !actor) return unavailable(c);
  const search = new URL(c.req.url).search;
  const url = `https://panel-api.internal/internal/panel/v1/${encodeURIComponent(session.workspaceId)}${path}${search}`;
  const res = await fetcher.fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...actor },
    ...(body === undefined ? {} : { body }),
  });
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json' } });
}

const seg = (value: string) => encodeURIComponent(value);

app.get('/projects', requireScope(SCOPE), (c) => forward(c, '/projects'));

/** The spec itself, or the `{ spec }` envelope a tool call sends. */
export function unwrapSpec(body: unknown): unknown {
  if (body && typeof body === 'object' && !Array.isArray(body) && !('kind' in body) && 'spec' in body) return (body as { spec: unknown }).spec;
  return body;
}

app.post('/query', requireScope(SCOPE), async (c) => {
  const text = await c.req.text();
  if (text.length > MAX_SPEC_BYTES) return c.json({ error: { code: 'BAD_REQUEST', message: 'The query spec is too large' } }, 400);
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'The body is not JSON' } }, 400);
  }
  return forward(c, '/query', JSON.stringify(unwrapSpec(body)));
});

app.get('/reports', requireScope(SCOPE), (c) => forward(c, '/reports'));
app.get('/reports/:id', requireScope(SCOPE), (c) => forward(c, `/reports/${seg(c.req.param('id'))}`));
app.get('/reports/:id/results', requireScope(SCOPE), (c) => forward(c, `/reports/${seg(c.req.param('id'))}/results`));
app.get('/dashboards', requireScope(SCOPE), (c) => forward(c, '/dashboards'));
app.get('/dashboards/:id', requireScope(SCOPE), (c) => forward(c, `/dashboards/${seg(c.req.param('id'))}`));
app.get('/cohorts', requireScope(SCOPE), (c) => forward(c, '/cohorts'));
app.get('/events', requireScope(SCOPE), (c) => forward(c, '/lexicon'));
app.get('/people', requireScope(SCOPE), (c) => forward(c, '/people'));
app.get('/people/:distinctId', requireScope(SCOPE), (c) => forward(c, `/people/${seg(c.req.param('distinctId'))}`));
app.get('/groups', requireScope(SCOPE), (c) => forward(c, '/groups'));
app.get('/groups/:type/:key', requireScope(SCOPE), (c) => forward(c, `/groups/${seg(c.req.param('type'))}/${seg(c.req.param('key'))}`));

export default app;
