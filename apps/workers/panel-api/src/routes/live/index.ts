/**
 * GET /api/panel/live?projectId: the realtime view, straight from the
 * project's Durable Object (`panel_reports:read`: it sits on the Overview next
 * to the traffic numbers). It answers the visitors with activity in the last
 * five and the last 30 minutes, the visitors in each of the last 30 minutes,
 * and the sessions of the last 30 minutes with the pages they are on (the 500
 * latest; the counts cover them all).
 *
 * A live session names its visitor by the id the site gave it, which can be a
 * user id or an email, so without `panel_people:read` that id is replaced by a
 * stable pseudonym: the view still counts and groups, it just cannot name
 * anyone.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { error, success } from '@weldsuite/worker-kit/response';
import type { PanelLiveDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { projectObjectStub } from '@weldsuite/panel-domain/project-object';
import type { Env, Variables } from '../../types';
import { sha256Hex } from '../../services/keys';
import { getProject } from '../../services/projects';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const query = z.object({ projectId: z.string().min(1).max(30) });

app.get('/', requirePermission('panel_reports:read'), zValidator('query', query), async (c) => {
  const { projectId } = c.req.valid('query');
  if (!(await getProject(c.get('tenantDb'), projectId))) return error.notFound(c, 'Project', projectId);
  if (!c.env.PANEL_PROJECT) return error.unavailable(c, 'The live view is not configured here');

  const live = await projectObjectStub(c.env.PANEL_PROJECT, projectId).live();
  const mayName = await hasContextPermission(c, 'panel_people:read');
  const sessions = mayName
    ? live.sessions
    : await Promise.all(live.sessions.map(async (s) => ({ ...s, distinctId: (await sha256Hex(`${projectId}:${s.distinctId}`)).slice(0, 12) })));
  const body: PanelLiveDto = { projectId, visitors: live.visitors, visitors30m: live.visitors30m, perMinute: live.perMinute, sessions };
  return success(c, body);
});

export default app;
