/**
 * Custom collector domains: /api/panel/projects/:id/domains (mounted under
 * the projects prefix in index.ts, like keys; the projects router, which the
 * Rust backend mirrors, does not serve /:id/domains). A project's own host
 * name (`stats.example.com`) that serves the SDK and takes its events, through
 * Cloudflare for SaaS (services/domains.ts). Everything here is
 * `panel_projects:manage`.
 *
 *   GET    /                     → the project's domains, with the DNS records to add
 *   POST   /                     → { hostname }: register it
 *   POST   /:domainId/refresh    → ask Cloudflare for its status now (the cron also does)
 *   DELETE /:domainId            → remove it
 *
 * An active domain carries `scriptUrl` (`https://<hostname>/s.js`) and the
 * install `snippet` for that host; the project's own install route
 * (`GET /api/panel/projects/:id/install`) keeps the shared collector host.
 *
 * Off (503 `FEATURE_UNAVAILABLE`) where `PANEL_SAAS_ZONE_ID`,
 * `PANEL_SAAS_CNAME_TARGET` or `CLOUDFLARE_API_TOKEN` is not set. Mutations
 * publish `panel_custom_domain` entity events (id, project, host name, status).
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { createPanelDomainSchema } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import type { PanelCustomDomain } from '@weldsuite/db/schema/master';
import type { Env, Variables } from '../../types';
import { getProject } from '../../services/projects';
import { createDomain, domainEventData, getDomain, listDomains, refreshDomain, removeDomain, saasConfig, toDomainDto, type SaasConfig } from '../../services/domains';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const MANAGE = 'panel_projects:manage';

function publish(c: Ctx, domain: PanelCustomDomain, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvent({ c, entityType: 'panel_custom_domain', entityId: domain.id, action, data: domainEventData(domain) });
}

function unavailable(c: Ctx): Response {
  return c.json({ error: { code: 'FEATURE_UNAVAILABLE', message: 'Custom collector domains are not available here' } }, 503);
}

type Setup = { ok: true; cfg: SaasConfig; token: string; workspaceId: string; projectId: string } | { ok: false; response: Response };

/** The SaaS setup, the workspace and the project (with its token, for the snippet). */
async function setup(c: Ctx): Promise<Setup> {
  const cfg = saasConfig(c.env);
  if (!cfg) return { ok: false, response: unavailable(c) };
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) return { ok: false, response: error.orgRequired(c) };
  const projectId = c.req.param('id') ?? '';
  const project = await getProject(c.get('tenantDb'), projectId);
  if (!project) return { ok: false, response: error.notFound(c, 'Project', projectId) };
  return { ok: true, cfg, token: project.token, workspaceId, projectId };
}

app.get('/', requirePermission(MANAGE), async (c) => {
  const s = await setup(c);
  if (!s.ok) return s.response;
  const domains = await listDomains(getMasterDb(c.env), s.workspaceId, s.projectId);
  return list(c, domains.map((d) => toDomainDto(d, s.token)), cursorPagination(domains.length, false, null));
});

app.post('/', requirePermission(MANAGE), zValidator('json', createPanelDomainSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const s = await setup(c);
  if (!s.ok) return s.response;
  const { hostname } = c.req.valid('json');
  const created = await createDomain(getMasterDb(c.env), s.cfg, { workspaceId: s.workspaceId, projectId: s.projectId, hostname, userId });
  if (!created.ok) {
    if (created.reason === 'cloudflare') return error.badGateway(c, created.message);
    return error.conflict(c, created.message);
  }
  publish(c, created.domain, 'created');
  return success(c, toDomainDto(created.domain, s.token), 201);
});

app.post('/:domainId/refresh', requirePermission(MANAGE), async (c) => {
  const s = await setup(c);
  if (!s.ok) return s.response;
  const domainId = c.req.param('domainId');
  const masterDb = getMasterDb(c.env);
  const domain = await getDomain(masterDb, s.workspaceId, s.projectId, domainId);
  if (!domain) return error.notFound(c, 'Domain', domainId);
  const fresh = await refreshDomain(masterDb, s.cfg, domain);
  if (fresh.status !== domain.status) publish(c, fresh, 'updated');
  return success(c, toDomainDto(fresh, s.token));
});

app.delete('/:domainId', requirePermission(MANAGE), async (c) => {
  const s = await setup(c);
  if (!s.ok) return s.response;
  const domainId = c.req.param('domainId');
  const masterDb = getMasterDb(c.env);
  const domain = await getDomain(masterDb, s.workspaceId, s.projectId, domainId);
  if (!domain) return error.notFound(c, 'Domain', domainId);
  const result = await removeDomain(masterDb, s.cfg, domain);
  // Removed at Cloudflare and here, or left `deleting` for the cron to finish: either way it is going.
  publish(c, result.domain, result.removed ? 'deleted' : 'updated');
  if (!result.removed) return c.json({ data: toDomainDto(result.domain, s.token) }, 202);
  return noContent(c);
});

export default app;
